// Run only against an explicitly authorized disposable FIPS client. This
// removes/restores that client's mesh route; it never changes the host daemon.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PeerTransport} from './distinct-peer-transport';
import {broker,nostr,check,command,fixtureToken} from './gate-client';
import {validateSignedResponse,safeBrokerError} from './signed-response';
const cfg=JSON.parse(await Bun.file(process.argv[2]).text());
const evidence=resolve(cfg.evidence);
check((await command(['git','check-ignore',evidence])).trim()===evidence,'evidence must be ignored');
check(!(await command(['git','ls-files',evidence])).trim(),'evidence must be untracked');
await mkdir(evidence,{recursive:true,mode:0o700});
check(!await Bun.file(evidence+'/results.json').exists(),'use a fresh evidence directory');
const results:any[]=[];
async function record(name:string,action:()=>Promise<any>){
  const at=new Date().toISOString();
  try{const value=await action();results.push({name,at,finished:new Date().toISOString(),passed:true,...value});}
  catch(error){results.push({name,at,passed:false,error:safeBrokerError(error)});throw error;}
  finally{await writeFile(evidence+'/results.json',JSON.stringify(results,null,2),{mode:0o600});}
}
const t=new PeerTransport(cfg.container,cfg.root,cfg.address);
const relay=new URL(cfg.root).origin.replace('http:','ws:')+'/';
const publisher=nostr.nip19.decode(new URL(cfg.root).pathname.split('/')[1]).data;
check(new URL(cfg.root).hostname===cfg.serviceNpub+'.fips','canonical host must match service peer');
const sign=async(e:any)=>{
  const result:any=await broker.callCapabilityBroker('/api/mcp/capabilities/nostr-event',{event:e});
  validateSignedResponse(result.event,{...e,pubkey:publisher},nostr.verifyEvent);return result.event;
};
const token=async()=>{
  const created_at=Math.floor(Date.now()/1000);
  const r:any=await broker.callCapabilityBroker('/api/mcp/capabilities/nip98',{url:cfg.root,method:'GET'});
  validateSignedResponse(JSON.parse(Buffer.from(r.token.slice(6),'base64').toString()),
    {kind:27235,created_at,content:'',tags:[['u',cfg.root],['method','GET']],pubkey:publisher},nostr.verifyEvent,process.env.SESSION_ID);
  return r.token;
};
const fixture=nostr.generateSecretKey();
const filter={kinds:[30617,30618],authors:[publisher],'#d':['synthetic']};
async function relayRead(mode:'member'|'nonmember'|'anonymous'){
  const s=t.socket();
  try{
    const challenge=await s.next();check(challenge[0]==='AUTH' && typeof challenge[1]==='string','missing native NIP42 challenge');
    if(mode!=='anonymous'){
      const e={kind:22242,content:'',created_at:Math.floor(Date.now()/1000),tags:[['relay',relay],['challenge',challenge[1]]]};
      const event=mode==='member'?await sign(e):nostr.finalizeEvent(e,fixture);
      s.send(['AUTH',event]);const auth=await s.next();check(auth[0]==='OK'&&auth[1]===event.id,'missing AUTH result');
      if(mode==='nonmember'){
        check(auth[2]===false && auth[3].startsWith('restricted:'),'nonmember admitted');
        // The service terminates rejected identities; require no event leakage.
        const terminal=await s.next();check(terminal[0]==='SOCKET_CLOSED','nonmember socket not closed');
        return {actor:event.pubkey,denial:auth.slice(2),terminal,events:0};
      }
      check(auth[2]===true,'member denied');
    }
    s.send(['REQ','distinct-peer',filter]);
    if(mode==='anonymous'){
      const m=await s.next();check(m[0]==='CLOSED' && m[2].startsWith('auth-required:'),'anonymous relay leaked');
      return {denial:m,events:0};
    }
    const events:any[]=[];
    for(;;){const m=await s.next();if(m[0]==='EOSE')break;
      check(m[0]==='EVENT'&&nostr.verifyEvent(m[2])&&m[2].pubkey===publisher,'unexpected relay event');
      events.push({id:m[2].id,kind:m[2].kind,sha256:new Bun.CryptoHasher('sha256').update(JSON.stringify(m[2])).digest('hex')});}
    check(events.length===2,'expected two synthetic events');return {actor:publisher,events};
  }finally{s.close();}
}
async function snapshot(label:string){
  const values:any={};
  for(const what of ['status','peers','links','sessions','transports']){
    const r=await t.run(['fipsctl','-s',cfg.socket,'show',what]);check(r.code===0,'client control unavailable');
    values[what]=JSON.parse(r.out);
  }
  const route=await t.run(['ip','-6','route','get',cfg.address]);check(route.code===0,'client route missing');
  values.route=route.out;
  await writeFile(evidence+'/'+label+'.json',JSON.stringify(values,null,2),{mode:0o600});return values;
}
let down=false;
try{
  await record('independent client preflight',async()=>{
    const inspect=JSON.parse(await command(['docker','inspect',cfg.container]))[0];
    check(inspect.HostConfig.Privileged===false && !['host','none'].includes(inspect.HostConfig.NetworkMode)
      && !inspect.HostConfig.NetworkMode.startsWith('container:') && !Object.keys(inspect.HostConfig.PortBindings??{}).length,'client namespace or published ports unsafe');
    check(inspect.Mounts.every((m:any)=>m.Destination==='/client'),'unexpected host mount');
    check(inspect.Config.Entrypoint.join(' ')==='/usr/local/bin/fips','client must run its own daemon');
    check(!inspect.Config.Env.some((e:string)=>/^(WINGMAN_CAPABILITY|SESSION_ID|FIPS_NSEC)=/.test(e)),'credential environment forbidden');
    const s=await snapshot('client-before');
    check(s.status.state==='running'&&s.status.tun_state==='active'&&s.status.persistent===true,'client daemon degraded');
    check(s.status.npub!==cfg.serviceNpub&&s.status.ipv6_addr!==cfg.address,'self node forbidden');
    check(s.peers.peers.some((p:any)=>p.npub===cfg.serviceNpub&&p.ipv6_addr===cfg.address&&p.connectivity==='connected'),'service peer not authenticated');
    check(s.route.includes('dev '+s.status.tun_name)&&s.route.includes('src '+s.status.ipv6_addr),'route does not use client TUN');
    check(cfg.tun===s.status.tun_name && /^fips[0-9]+$/.test(cfg.tun),'unexpected client interface');
    return {clientNpub:s.status.npub,clientAddress:s.status.ipv6_addr,serviceNpub:cfg.serviceNpub,serviceAddress:cfg.address,
      version:s.status.version,image:inspect.Image,network:inspect.HostConfig.NetworkMode,route:s.route};
  });
  await record('NIP11 GRASP08 over distinct peer',async()=>{
    const r=await t.http('/','',true);check(r.exit===0&&r.status===200,'discovery unavailable');
    const d=JSON.parse(r.body);check(d.pubkey===cfg.graspPubkey&&d.supported_grasps.includes('GRASP-08')&&d.supported_nips.includes(42),'wrong discovery');return {discovery:d};
  });
  await record('anonymous and nonmember Git denied on peer',async()=>{
    const responses=[];for(const auth of ['',fixtureToken(fixture,cfg.root)]){
      const r=await t.http('/info/refs?service=git-upload-pack',auth);check(r.exit===0&&r.status===401&&r.body==='','unauthorized Git leaked');responses.push({status:r.status,bytes:r.body.length});}
    return {nonmember:nostr.getPublicKey(fixture),responses};
  });
  await record('anonymous relay denied on peer',()=>relayRead('anonymous'));
  await record('nonmember relay denied on peer',()=>relayRead('nonmember'));
  await record('Rick broker NIP42 authenticated synthetic read',()=>relayRead('member'));
  await record('Rick broker Git advertisement',async()=>{
    const r=await t.http('/info/refs?service=git-upload-pack',await token());check(r.exit===0&&r.status===200&&r.body.includes(cfg.main),'member refs unavailable');return {status:r.status,main:cfg.main};
  });
  await record('fresh private Git clone and objects',async()=>{
    const r=await t.clone(await token(),cfg.clonePrefix+'-available');
    check(r.exit===0&&r.main===cfg.main&&r.parent===cfg.parent&&r.fsck,'clone mismatch');
    check(JSON.stringify(r.files)===JSON.stringify(['README.md','second.txt']),'unexpected files');
    check(r.contents['README.md']==='# Synthetic private GRASP PoC\nNo real project content.\n'
      &&r.contents['second.txt']==='Synthetic update for fetch verification.\n','unexpected content');return r;
  });
  const after=await snapshot('client-after-reads');
  check(after.sessions.sessions.some((s:any)=>s.npub===cfg.serviceNpub&&s.state==='established'
    &&s.stats.packets_sent>0&&s.stats.packets_recv>0),'no encrypted service session');
  await record('client mesh route removal rejects fresh Git and relay without fallback',async()=>{
    const fresh=await token();
    const stop=await t.run(['ip','-6','route','del','fd00::/8','dev',cfg.tun]);check(stop.code===0,'could not disable client path');down=true;
    const http=await t.http('/info/refs?service=git-upload-pack',fresh);check(http.exit!==0&&http.status===0,'Git survived client path loss');
    const s=t.socket();let terminal;try{terminal=await s.next();check(['SOCKET_CLOSED','SOCKET_ERROR'].includes(terminal[0]),'relay survived path loss');}finally{s.close();}
    const clone=await t.clone(fresh,cfg.clonePrefix+'-unavailable');check(clone.exit!==0,'fresh clone survived path loss');
    return {httpExit:http.exit,httpStatus:http.status,relay:terminal,cloneExit:clone.exit};
  });
}catch(error){console.error(safeBrokerError(error));process.exitCode=1;}
finally{
  fixture.fill(0);
  if(down){const r=await t.run(['ip','-6','route','replace','fd00::/8','dev',cfg.tun,'proto','static','metric','1024']);check(r.code===0,'client route restoration failed');}
}
if(!process.exitCode){
  await record('client path recovery',async()=>{const r=await t.http('/info/refs?service=git-upload-pack',await token());check(r.exit===0&&r.status===200&&r.body.includes(cfg.main),'client did not recover');return {status:r.status,main:cfg.main};});
  await snapshot('client-final');
}
console.log(JSON.stringify({evidence,passed:results.filter(r=>r.passed).length,total:results.length}));
