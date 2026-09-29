// Private PoC probes. Signed tokens and disposable secret keys stay in memory.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const autopilot = process.env.AUTOPILOT_REPO ?? `${process.env.HOME}/code/wm/autopilot`;
export const nostr = await import(`${autopilot}/node_modules/nostr-tools/lib/esm/index.js`);
export const broker = await import(`${autopilot}/src/mcp/capability-client.ts`);
export function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export async function command(args: string[], input?: string): Promise<string> {
  const p = Bun.spawn(args, {stdin: input === undefined ? 'ignore' : 'pipe', stdout:'pipe', stderr:'pipe'});
  if (input !== undefined) { p.stdin.write(input); p.stdin.end(); }
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  check(code === 0, `Command ${args[0]} ${args[1]} failed (${code}): ${err.slice(0,300)}`);
  return out;
}
export function fixtureToken(key: Uint8Array, root: string, offset = 0, mutate?: (e:any)=>void) {
  const event = nostr.finalizeEvent({kind:27235,content:'',created_at:Math.floor(Date.now()/1000)+offset,tags:[['u',root],['method','GET']]}, key);
  mutate?.(event);
  return 'Nostr '+Buffer.from(JSON.stringify(event)).toString('base64');
}
export class Client {
  constructor(public root: string, public relay: string, public container?: string) {}
  async http(path: string, token = '', method = 'GET', body?: string) {
    if (!this.container) {
      const r = await fetch(this.root+path,{method,headers:{...(token?{authorization:token}:{}),...(body?{'content-type':'application/x-git-receive-pack-request'}:{})},body,redirect:'manual',signal:AbortSignal.timeout(10000)});
      return {status:r.status,body:await r.text()};
    }
    const url = 'http://127.0.0.1:7334'+new URL(this.root).pathname+path;
    const cfg = [`url = ${JSON.stringify(url)}`,`request = ${JSON.stringify(method)}`,'max-time = 10','silent','show-error',`write-out = "\\n%{http_code}"`];
    if(token) cfg.push(`header = ${JSON.stringify('Authorization: '+token)}`);
    if(body) cfg.push('header = "Content-Type: application/x-git-receive-pack-request"',`data-binary = ${JSON.stringify(body)}`);
    const out = await command(['docker','exec','-i',this.container,'curl','--config','-'],cfg.join('\n'));
    const split = out.lastIndexOf('\n');
    return {status:Number(out.slice(split+1)),body:out.slice(0,split)};
  }
  socket() {
    let child:any;
    const queue:any[]=[]; let waiter:((m:any)=>void)|undefined;
    const deliver=(m:any)=>waiter?(waiter(m),waiter=undefined):queue.push(m);
    let send:(m:any)=>void,close:()=>void;
    if(this.container){
      child=spawn('node',[import.meta.dir+'/isolated-relay.mjs',this.container,this.relay],{stdio:['pipe','pipe','ignore']});
      createInterface({input:child.stdout}).on('line',line=>deliver(JSON.parse(line)));
      child.on('exit',()=>deliver(['SOCKET_CLOSED']));
      send=m=>child.stdin.write(JSON.stringify(m)+'\n');close=()=>child.kill();
    }else{
      const ws=new WebSocket(this.relay);
      ws.onmessage=e=>deliver(JSON.parse(String(e.data)));
      ws.onclose=e=>deliver(['SOCKET_CLOSED',e.code]);
      ws.onerror=()=>deliver(['SOCKET_ERROR']);
      send=m=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(m));};close=()=>ws.close();
    }
    return {send,
      next:()=>new Promise<any>((resolve,reject)=>{
        if(queue.length)return resolve(queue.shift());
        const timer=setTimeout(()=>{waiter=undefined;reject(new Error('relay timeout'));},10000);
        waiter=m=>{clearTimeout(timer);resolve(m);};
      }), close};
  }
  async authenticate(sign:(e:any)=>Promise<any>|any,offset=0,invalid?:string) {
    const s=this.socket(); const challenge=await s.next(); check(challenge[0]==='AUTH','missing challenge: '+JSON.stringify(challenge));
    const e=await sign({kind:22242,content:'',created_at:Math.floor(Date.now()/1000)+offset,tags:[['relay',invalid==='relay'?'ws://invalid.example/':this.relay],['challenge',invalid==='challenge'?'wrong':challenge[1]]]});
    if(invalid==='signature')e.sig='0'.repeat(128);
    s.send(['AUTH',e]); const auth=await s.next(); check(auth[0]==='OK' && auth[1]===e.id,'missing AUTH response');
    return {s,auth};
  }
  async events(sign:(e:any)=>Promise<any>|any, filter:object) {
    const {s,auth}=await this.authenticate(sign); check(auth[2]===true,'member AUTH denied');
    try {s.send(['REQ','gate',filter]); const events:any[]=[];
      for(;;){const m=await s.next();if(m[0]==='EOSE')return events;
        check(m[0]==='EVENT' && nostr.verifyEvent(m[2]),'invalid event response');events.push(m[2]);}
    } finally{s.close();}
  }
}
