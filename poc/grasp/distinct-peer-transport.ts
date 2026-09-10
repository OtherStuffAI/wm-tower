// Transport only through a disposable client's network namespace. Broker
// capability/session tokens stay in the caller; exact signatures use stdin.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {isIP} from 'node:net';
import {check} from './gate-client';

export class PeerTransport {
  constructor(public container: string, public root: string, public address: string) {
    const u = new URL(root);
    check(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(container), 'invalid container');
    check(u.protocol==='http:' && u.hostname.endsWith('.fips') && !!u.port && !u.username && !u.password
      && !u.search && !u.hash && /^\/npub1[a-z0-9]+\/synthetic\.git$/.test(u.pathname), 'synthetic canonical root required');
    check(isIP(address)===6 && address.startsWith('fd'), 'mesh IPv6 required');
  }
  async run(args: string[], input?: string) {
    const p=Bun.spawn(['docker','exec',...(input===undefined?[]:['-i']),this.container,...args],
      {stdin:input===undefined?'ignore':'pipe',stdout:'pipe',stderr:'pipe'});
    if(input!==undefined){p.stdin.write(input);p.stdin.end();}
    const timer=setTimeout(()=>p.kill(),25000);
    try {
      const [out,code]=await Promise.all([new Response(p.stdout).text(),p.exited,new Response(p.stderr).text()]);
      return {code,out}; // stderr may contain credentials; never emit it.
    }finally{clearTimeout(timer);}
  }
  async http(path: string, token='', discovery=false) {
    check(path==='/info/refs?service=git-upload-pack'||path==='/', 'unexpected read path');
    const u=new URL(this.root);
    const lines=[`url = ${JSON.stringify(discovery?u.origin+'/':this.root+path)}`,
      `resolve = ${JSON.stringify(u.hostname+':'+u.port+':['+this.address+']')}`,
      'noproxy = "*"','max-time = 8','silent','show-error','write-out = "\\n%{http_code}"'];
    if(token)lines.push(`header = ${JSON.stringify('Authorization: '+token)}`);
    if(discovery)lines.push('header = "Accept: application/nostr+json"');
    const r=await this.run(['curl','--config','-'],lines.join('\n'));
    const split=r.out.lastIndexOf('\n');
    return {exit:r.code,status:Number(r.out.slice(split+1)),body:r.out.slice(0,split)};
  }
  socket() {
    const u=new URL(this.root); const relay=u.origin.replace('http:','ws:')+'/';
    const child=spawn('node',[import.meta.dir+'/peer-relay.mjs',this.container,relay,this.address],{stdio:['pipe','pipe','ignore']});
    const queue:any[]=[];let waiter:((m:any)=>void)|undefined;
    const deliver=(m:any)=>{if(waiter){const w=waiter;waiter=undefined;w(m);}else queue.push(m);};
    createInterface({input:child.stdout!}).on('line',line=>deliver(JSON.parse(line)));
    child.on('exit',()=>deliver(['SOCKET_CLOSED']));
    return {send:(m:any)=>child.stdin!.write(JSON.stringify(m)+'\n'),close:()=>{child.stdin?.end();child.kill();},
      next:()=>new Promise<any>((resolve,reject)=>{
        if(queue.length)return resolve(queue.shift());
        const timer=setTimeout(()=>{waiter=undefined;reject(new Error('peer relay timeout'));},10000);
        waiter=m=>{clearTimeout(timer);resolve(m);};
      })};
  }
  async clone(token: string, directory: string) {
    check(/^\/client\/clone-[a-z0-9-]+$/.test(directory),'fresh private clone directory required');
    // Clean Git environment, no credential helper, redirects or proxy. Only
    // the exact HTTP signature reaches this process, never the broker token.
    const script=`const fs=require('node:fs');const cp=require('node:child_process');
      let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
        const c=JSON.parse(input);if(fs.existsSync(c.directory))process.exit(3);
        const u=new URL(c.root);const env={PATH:process.env.PATH,HOME:'/var/empty',
          GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:'http',
          GIT_CONFIG_COUNT:'6',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:'Authorization: '+c.token,
          GIT_CONFIG_KEY_1:'http.curloptResolve',GIT_CONFIG_VALUE_1:u.hostname+':'+u.port+':['+c.address+']',
          GIT_CONFIG_KEY_2:'http.followRedirects',GIT_CONFIG_VALUE_2:'false',
          GIT_CONFIG_KEY_3:'credential.helper',GIT_CONFIG_VALUE_3:'',
          GIT_CONFIG_KEY_4:'http.proxy',GIT_CONFIG_VALUE_4:'',
          GIT_CONFIG_KEY_5:'http.lowSpeedTime',GIT_CONFIG_VALUE_5:'8'};
        const p=cp.spawnSync('git',['clone','--no-checkout',c.root,c.directory],{env,encoding:'utf8',timeout:15000});
        if(p.status!==0){console.log(JSON.stringify({exit:p.status??124}));return;}
        const git=args=>{const r=cp.spawnSync('git',['-C',c.directory,...args],{env,encoding:'utf8'});if(r.status!==0)process.exit(4);return r.stdout;};
        const main=git(['rev-parse','HEAD']).trim(),parent=git(['rev-parse','HEAD^']).trim();
        const files=git(['ls-tree','--name-only','HEAD']).trim().split('\\n');
        const contents=Object.fromEntries(files.map(f=>[f,git(['show','HEAD:'+f])]));
        git(['fsck','--full']);console.log(JSON.stringify({exit:0,main,parent,files,contents,fsck:true}));
      });`;
    const r=await this.run(['node','-e',script],JSON.stringify({root:this.root,address:this.address,token,directory}));
    check(r.code===0,'clone probe process failed');return JSON.parse(r.out);
  }
}
