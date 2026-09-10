// Run only against an explicitly configured synthetic PoC. Output is operational
// evidence and must be redirected into verified ignored private storage.
import {Client,broker,nostr,check,command,fixtureToken} from './gate-client';
import {mkdir,chmod,writeFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateSignedResponse} from './signed-response';
const cfg=JSON.parse(await Bun.file(process.argv[2]).text());
const evidence=resolve(cfg.evidence);
check((await command(['git','check-ignore',evidence])).trim()===evidence,'evidence must be ignored');
check(!(await command(['git','ls-files',evidence])).trim(),'evidence must be untracked');
await mkdir(evidence,{recursive:true,mode:0o700}); await chmod(evidence,0o700);
const results:any[]=cfg.resume ? JSON.parse(await Bun.file(evidence+'/results.json').text()) : [];
async function record(name:string, action:()=>Promise<any>){const at=new Date().toISOString();
  try{const data=await action();results.push({name,at,finished:new Date().toISOString(),passed:true,...data});}
  catch(e){results.push({name,at,passed:false,error:String(e)});throw e;}
  finally{await writeFile(evidence+'/results.json',JSON.stringify(results,null,2),{mode:0o600});}
}
const client=new Client(cfg.root,cfg.relay);
const publisher=nostr.nip19.decode(new URL(cfg.root).pathname.split('/')[1]).data;
const filter={kinds:[30617,30618],authors:[publisher],'#d':['synthetic']};
const sign=async(e:any)=>{const result=(await broker.callCapabilityBroker('/api/mcp/capabilities/nostr-event',{event:e})).event;
  validateSignedResponse(result,{...e,pubkey:publisher},nostr.verifyEvent);return result;};
const token=async()=>{const created_at=Math.floor(Date.now()/1000);const t=(await broker.callCapabilityBroker('/api/mcp/capabilities/nip98',{url:cfg.root,method:'GET'})).token;
  validateSignedResponse(JSON.parse(Buffer.from(t.slice(6),'base64').toString()),{kind:27235,created_at,content:'',tags:[['u',cfg.root],['method','GET']],pubkey:publisher},nostr.verifyEvent,process.env.SESSION_ID);return t;};
const fixture=nostr.generateSecretKey(); const fixtureSign=(e:any)=>nostr.finalizeEvent(e,fixture);
const fixtureNpub=nostr.nip19.npubEncode(nostr.getPublicKey(fixture));
const compose=['docker','compose','--env-file',cfg.envFile,'-f',cfg.composeFile];
const repoPath='/data/git'+new URL(cfg.root).pathname;
const refs=(container:string)=>command(['docker','exec',container,'git','--git-dir='+repoPath,'show-ref']);
const pub=async(container:string)=>JSON.parse(await command(['docker','exec',container,'curl','-fsS','-H','Accept: application/nostr+json','http://127.0.0.1:7334/'])).pubkey;
const eventSummary=(events:any[])=>events.map(e=>({id:e.id,sha256:new Bun.CryptoHasher('sha256').update(JSON.stringify(e)).digest('hex')})).sort((a,b)=>a.id.localeCompare(b.id));
const inspect=JSON.parse(await command(['docker','inspect',cfg.live]))[0];
const env=inspect.Config.Env.filter((e:string)=>e.startsWith('NGIT_'));
check(env.includes('NGIT_PRIVATE_MODE=true') && env.includes('NGIT_SYNC_PLUS_ENABLED=false') && env.includes('NGIT_GRASP06_ENABLE=false'),'private config required');
check(env.includes('NGIT_USER_INDEX_RELAYS=') && env.includes('NGIT_SYNC_PLUS_FALLBACK_RELAYS='),'external relay config forbidden');
const before={identity:await pub(cfg.live),refs:await refs(cfg.live),events:eventSummary(await client.events(sign,filter))};
check(before.refs===cfg.main+' refs/heads/main\n','unexpected live refs');
check(before.events.length>=2,'missing synthetic events');
await record('live baseline',async()=>before);
const oldToken=await token(); const tokenTime=Math.floor(Date.now()/1000);
await record('live nonmember Git receive-pack and post-denied relay REQ',async()=>{
  const requests=[];
  const line=cfg.main+' '+cfg.rootOid+' refs/heads/main\n';
  const packet=(Buffer.byteLength(line)+4).toString(16).padStart(4,'0')+line+'0000';
  for(const path of ['/info/refs?service=git-receive-pack','/git-receive-pack']){
    const r=await client.http(path,fixtureToken(fixture,cfg.root),path.includes('info')?'GET':'POST',path.includes('info')?undefined:packet);
    check(r.status===401 && r.body==='','nonmember Git access');requests.push({path,...r});}
  const {s,auth}=await client.authenticate(fixtureSign);try{
    check(auth[2]===false && auth[3].startsWith('restricted:'),'nonmember auth not restricted');
    s.send(['REQ','post-denial',filter]);const terminal=await s.next();check(terminal[0]==='SOCKET_CLOSED','post-denied auth socket not closed');
    return {requests,auth:auth.slice(2),terminal,eventCount:0};
  }finally{s.close();}
});
await record('live fresh Rick credential',async()=>{const r=await client.http('/info/refs?service=git-upload-pack',oldToken);check(r.status===200&&r.body.includes(cfg.main),'fresh token control');return {status:r.status,tokenTime};});
// A cold archive is taken only while both PoC services are stopped. Always
// restore live service in finally, even if the archive fails.
const snapshot=evidence+'/volume.tar';
if(cfg.resume){
  const original=results.find(r=>r.name==='consistent cold volume snapshot and live recreation'&&r.passed);
  check(original && original.sha256===(await command(['shasum','-a','256',snapshot])).split(' ')[0],'resume snapshot hash mismatch');
  check(JSON.stringify(before)===JSON.stringify(Object.fromEntries(Object.entries(results.find(r=>r.name==='live baseline')).filter(([k])=>['identity','refs','events'].includes(k)))),'resume live baseline changed');
} else {
check(!await Bun.file(snapshot).exists(),'refuse overwrite snapshot');
await record('consistent cold volume snapshot and live recreation',async()=>{
  const stoppedAt=new Date().toISOString();
  try {
    await command([...compose,'stop','grasp-ingress','grasp-poc']);
    const state=JSON.parse(await command(['docker','inspect',cfg.live]))[0].State;
    check(!state.Running && state.ExitCode===0 && !state.OOMKilled,'writer did not stop cleanly');
    await command(['docker','run','--rm','--network','none','--entrypoint','tar','-v',cfg.volume+':/source:ro','-v',evidence+':/backup',inspect.Image,'-C','/source','-cpf','/backup/volume.tar','.']);
    await chmod(snapshot,0o600);
  } finally {
    await command([...compose,'up','-d','--no-build','--no-deps','--force-recreate','grasp-poc']);
    await command([...compose,'up','-d','--no-build','--no-deps','--force-recreate','grasp-ingress']);
  }
  return {stoppedAt,restartedAt:new Date().toISOString(),snapshot,bytes:(await stat(snapshot)).size,sha256:(await command(['shasum','-a','256',snapshot])).split(' ')[0]};
});
}
async function healthy(c:Client){for(let n=0;n<40;n++){try{const r=await c.http('/info/refs?service=git-upload-pack',fixtureToken(fixture,cfg.root));if([200,401].includes(r.status))return;}catch{}await Bun.sleep(500);}throw new Error('service unavailable');}
await healthy(client);
await record('live persistence after recreation',async()=>{
  const after={identity:await pub(cfg.live),refs:await refs(cfg.live),events:eventSummary(await client.events(sign,filter))};
  check(JSON.stringify(after)===JSON.stringify(before),'live persistence mismatch');return after;
});
const isolated=cfg.isolatedName;
const isolatedVolume=cfg.isolatedVolume;
const exists=await Bun.spawn(['docker','volume','inspect',isolatedVolume],{stdout:'ignore',stderr:'ignore'}).exited;
check(exists!==0,'isolated volume already exists');
await command(['docker','volume','create',isolatedVolume]);
await command(['docker','run','--rm','--network','none','--entrypoint','tar','-v',isolatedVolume+':/restore','-v',evidence+':/backup:ro',inspect.Image,'-C','/restore','-xpf','/backup/volume.tar']);
const start=async(addFixture:boolean)=>{
  const updated=env.map((e:string)=>e.startsWith('NGIT_PRIVATE_MEMBERS=')&&addFixture?e+','+fixtureNpub:e);
  await command(['docker','run','-d','--name',isolated,'--network','none',...updated.flatMap((e:string)=>['-e',e]),'-v',isolatedVolume+':/data',inspect.Image]);
};
const isolatedClient=new Client(cfg.root,cfg.relay,isolated);
await start(true);
try{
  await healthy(isolatedClient);
  await record('isolated restore same identity refs and events',async()=>{
    const restored={identity:await pub(isolated),refs:await refs(isolated),events:eventSummary(await isolatedClient.events(fixtureSign,filter))};
    check(JSON.stringify(restored)===JSON.stringify(before),'restore data mismatch');
    const network=JSON.parse(await command(['docker','inspect',isolated]))[0];
    check(network.HostConfig.NetworkMode==='none' && Object.keys(network.HostConfig.PortBindings??{}).length===0,'restore exposed');
    await command(['docker','exec',isolated,'git','--git-dir='+repoPath,'fsck','--full']);
    const objects=await command(['docker','exec',isolated,'git','--git-dir='+repoPath,'rev-list','--objects','--all']);
    check(objects===await command(['docker','exec',cfg.live,'git','--git-dir='+repoPath,'rev-list','--objects','--all']),'restored objects mismatch');
    return {...restored,objects,fsck:'passed',networkMode:'none',ports:[],image:inspect.Image,volume:isolatedVolume};
  });
  await record('isolated admitted fixture auth-age and invalid auth',async()=>{
    const requests=[];
    for(const [name,offset,bad,status] of [['fresh',0,false,200],['expired',-300,false,401],['future',300,false,401],['invalid signature',0,true,401]] as const){
      const r=await isolatedClient.http('/info/refs?service=git-upload-pack',fixtureToken(fixture,cfg.root,offset,bad?e=>e.sig='0'.repeat(128):undefined));
      check(r.status===status && (status!==401||r.body===''),'fixture HTTP '+name);requests.push({name,offsetSeconds:offset,status:r.status,bytes:r.body.length});}
    for(const [name,offset,invalid] of [['expired',-300,undefined],['future',300,undefined],['invalid signature',0,'signature'],['wrong challenge',0,'challenge'],['wrong relay',0,'relay']] as const){
      const {s,auth}=await isolatedClient.authenticate(fixtureSign,offset,invalid);try{check(auth[2]===false&&auth[3].startsWith('auth-required:'),'fixture WS '+name);s.send(['REQ','invalid',filter]);const denial=await s.next();check(denial[0]==='CLOSED','invalid auth leaked');requests.push({name:'relay '+name,auth:auth.slice(2),denial});}finally{s.close();}}
    return {scope:'admitted disposable fixture, restored data, identical image/config except added member',requests};
  });
  await record('isolated read-only canonical ref and state write denial',async()=>{
    // Roll back main to an existing object: valid pkt-line, no pack needed.
    const line=cfg.main+' '+cfg.rootOid+' refs/heads/main\n';
    const body=(Buffer.byteLength(line)+4).toString(16).padStart(4,'0')+line+'0000';
    const r=await isolatedClient.http('/git-receive-pack',fixtureToken(fixture,cfg.root),'POST',body);
    check(r.status===200 && /^\w{4}ERR authorisation failed:/.test(r.body),'missing Git authorization rejection');
    check(await refs(isolated)===before.refs,'read-only changed refs');
    const {s,auth}=await isolatedClient.authenticate(fixtureSign);check(auth[2]===true,'fixture not admitted');
    try{
      const event=fixtureSign({kind:30618,content:'',created_at:Math.floor(Date.now()/1000),tags:[['d','synthetic'],['HEAD','ref: refs/heads/main'],['refs/heads/main',cfg.rootOid],['r',cfg.rootOid,'euc'],['a','30617:'+publisher+':synthetic']]});
      s.send(['EVENT',event]);const denial=await s.next();check(denial[0]==='OK'&&denial[1]===event.id&&denial[2]===false&&denial[3]==='restricted: author not authorized for this repository','read-only state not rejected for authority');
      const events=eventSummary(await isolatedClient.events(fixtureSign,filter));check(JSON.stringify(events)===JSON.stringify(before.events),'canonical events changed');
      return {http:r,relayDenial:denial.slice(2),refs:await refs(isolated),events};
    }finally{s.close();}
  });
  await record('isolated membership refresh removal and existing session',async()=>{
    const {s,auth}=await isolatedClient.authenticate(fixtureSign);check(auth[2]===true,'fixture initial auth');
    s.send(['REQ','existing',filter]);let count=0;for(;;){const m=await s.next();if(m[0]==='EOSE')break;check(m[0]==='EVENT','fixture read');count++;}check(count>=2,'fixture read control');
    await command(['docker','stop','--time','30',isolated]);const closed=await s.next();s.close();check(closed[0]==='SOCKET_CLOSED','old session survived stop');
    await command(['docker','rm',isolated]);await start(false);await healthy(isolatedClient);
    const r=await isolatedClient.http('/info/refs?service=git-upload-pack',fixtureToken(fixture,cfg.root));check(r.status===401&&r.body==='','removed fixture HTTP access');
    const denied=await isolatedClient.authenticate(fixtureSign);check(denied.auth[2]===false,'removed fixture WS access');denied.s.close();
    const retained=eventSummary(await isolatedClient.events(sign,filter));check(JSON.stringify(retained)===JSON.stringify(before.events),'retained Rick lost events');
    return {scope:'same env replacement plus recreation as documented refresh; no live human removal or hot-reload claim',priorEvents:count,closed,status:r.status,relayDenial:denied.auth.slice(2),retainedEvents:retained};
  });
}finally{await command(['docker','stop','--time','30',isolated]);}
await record('live naturally expired Rick Git credential',async()=>{
  while(Math.floor(Date.now()/1000)-tokenTime<=62)await Bun.sleep(1000);
  const r=await client.http('/info/refs?service=git-upload-pack',oldToken);check(r.status===401&&r.body==='','expired live credential admitted');
  const fresh=await client.http('/info/refs?service=git-upload-pack',await token());check(fresh.status===200&&fresh.body.includes(cfg.main),'fresh Rick unavailable');
  return {ageSeconds:Math.floor(Date.now()/1000)-tokenTime,expiredStatus:r.status,freshStatus:fresh.status};
});
await record('final live health and footprint',async()=>{
  const frontend=await fetch(cfg.frontend,{signal:AbortSignal.timeout(10000)});check(frontend.status===200,'frontend unavailable');
  const html=await frontend.text();check(html.includes('<html'),'frontend invalid');
  check(await refs(cfg.live)===before.refs,'final refs changed');
  return {frontendStatus:frontend.status,frontendSha256:new Bun.CryptoHasher('sha256').update(html).digest('hex'),identity:await pub(cfg.live),refs:await refs(cfg.live),footprint:await command(['docker','stats','--no-stream','--format','{{json .}}',cfg.live,cfg.ingress]),volumeBytes:await command(['docker','exec',cfg.live,'du','-sb','/data'])};
});
console.log(JSON.stringify({evidence,passed:results.filter(r=>r.passed).length,results},null,2));
