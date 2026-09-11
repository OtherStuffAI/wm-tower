// Explicit plan/check-signing/publish runner; no policy management or raw keys.
import {mkdirSync,existsSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {validateReviewPlan,cleanGitEnvironment} from './private-review-plan';
import {validateSignedResponse,safeBrokerError} from './signed-response';
import {Client,nostr,broker,check} from './gate-client';

const [mode,configPath,expectedHash]=process.argv.slice(2);
check(['plan','check-signing','publish'].includes(mode),'Use plan|check-signing|publish CONFIG SHA256');
const config=resolve(configPath), directory=dirname(config);
const raw=await Bun.file(config).text();
check(createHash('sha256').update(raw).digest('hex')===expectedHash,'Reviewed config hash mismatch');
const c=validateReviewPlan(JSON.parse(raw));
check(nostr.nip19.npubEncode(c.pubkey)===c.actor,'Public identity mismatch');
const env=cleanGitEnvironment(process.env);
async function git(args:string[],cwd:string,extra:Record<string,string>={}) {
  const p=Bun.spawn(['git',...args],{cwd,env:{...env,...extra},stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>p.kill(),55000);
  const [out,,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  clearTimeout(timer);
  check(code===0,`Git ${args[0]} failed (${code}); output suppressed to protect credentials`);
  return out.trim();
}
const repoRoot=await git(['rev-parse','--show-toplevel'],import.meta.dir);
await git(['check-ignore',config],repoRoot);
check((await git(['ls-files','--',config],repoRoot))==='','Operational config must be untracked');
check(directory.startsWith(realpathSync(repoRoot)+'/tmp/docs/handoffs/'),'Evidence must use ignored handoffs');
const source=realpathSync(c.source);
check(await git(['rev-parse',c.head+'^'],source)===c.base,'PR must be directly based on reviewed main');
check(await git(['rev-list','--max-parents=0',c.head],source)===c.rootOid,'Unexpected upstream root');
const files=await git(['diff','--name-only',c.base,c.head],source);
check(!files.split('\n').some(f=>/^(tmp\/|\.runtime\/|\.env($|\.)|.*hosting)/i.test(f)),'Operational or hosting file in patch');
// Abbreviated object IDs vary with repository size and local core.abbrev.
const patch=await git(['diff','--no-ext-diff','--no-textconv','--binary','--full-index',c.base,c.head],source);
// Prepare only reachable objects from the pinned source commits, without remotes.
const staging=directory+'/import.git';
if(!existsSync(staging)){
  mkdirSync(staging,{mode:0o700});
  await git(['init','--bare','--initial-branch=main'],staging);
  await git(['fetch','--no-tags',source,`${c.base}:refs/heads/main`,`${c.head}:refs/heads/${c.branch}`],staging);
}
check(await git(['for-each-ref','--format=%(objectname) %(refname)'],staging)===`${c.base} refs/heads/main\n${c.head} refs/heads/${c.branch}`,'Unexpected staging refs');
check(await git(['remote'],staging)==='','Staging must have no remotes');
await git(['fsck','--full'],staging);
const plan={configHash:expectedHash,base:c.base,head:c.head,files:files.split('\n'),canonicalDiffSha256:createHash('sha256').update(patch).digest('hex'),staging,destinations:[c.relay,c.root],mode};
writeFileSync(directory+'/plan.json',JSON.stringify(plan,null,2),{mode:0o600});
if(mode==='plan'){console.log(JSON.stringify(plan,null,2));process.exit(0);}

const sign=async(template:any)=>{
  const e={...template,created_at:template.created_at??Math.floor(Date.now()/1000)};
  const r:any=await broker.callCapabilityBroker('/api/mcp/capabilities/nostr-event',{event:e});
  check(r.signerNpub===c.actor,'Unexpected actor');
  validateSignedResponse(r.event,{...e,pubkey:c.pubkey},nostr.verifyEvent);return r.event;
};
const token=async()=>{
  const created_at=Math.floor(Date.now()/1000);
  const r:any=await broker.callCapabilityBroker('/api/mcp/capabilities/nip98',{url:c.root,method:'GET'});
  check(r.signedBy===c.actor && r.token?.startsWith('Nostr '),'Unexpected actor');
  validateSignedResponse(JSON.parse(Buffer.from(r.token.slice(6),'base64').toString()),
    {kind:27235,created_at,content:'',tags:[['u',c.root],['method','GET']],pubkey:c.pubkey},nostr.verifyEvent,process.env.SESSION_ID);
  return r.token as string;
};
const credential=async()=>({GIT_CONFIG_COUNT:'5',GIT_CONFIG_KEY_4:`http.${c.root}.extraHeader`,GIT_CONFIG_VALUE_4:'Authorization: '+await token()});
let socket:ReturnType<Client['socket']>|undefined;
const evidence:any={...plan,steps:[]};
const save=()=>writeFileSync(directory+'/result.json',JSON.stringify(evidence,null,2),{mode:0o600});
try {
  // Gate ALL publication kinds and HTTP signing before any repository mutation.
  const signed=[];
  for(const e of c.events) signed.push(await sign(e));
  await token();
  if(mode==='check-signing') {
    evidence.steps.push('Exact publication events and root credential signed; no publication');save();
  } else {
    check(!Object.entries(process.env).some(([k,v])=>/proxy/i.test(k) && v),'Unexpected proxy environment');
    const client=new Client(c.root,c.relay);
    const discovery=await fetch(new URL(c.root).origin+'/',{headers:{accept:'application/nostr+json'},redirect:'error',signal:AbortSignal.timeout(10000)});
    check(discovery.ok,'No private service discovery');
    const nip11:any=await discovery.json();
    check(nip11.supported_grasps?.includes('GRASP-08') && nip11.supported_nips?.includes(42) && nip11.supported_nips?.includes(98),'No private service advertisement');
    evidence.steps.push({servicePubkey:nip11.pubkey,privateService:true});save();
    const anonymous=await client.http('/info/refs?service=git-upload-pack');
    check(anonymous.status===401 && anonymous.body==='','Anonymous Git not denied');
    const anon=client.socket();
    try {check((await anon.next())[0]==='AUTH','No private relay challenge');anon.send(['REQ','denial',{kinds:[30617],'#d':[c.identifier]}]);
      const denial=await anon.next();check(denial[0]==='CLOSED' && denial[2]?.startsWith('auth-required:'),'Anonymous relay not denied');
    } finally {anon.close();}
    const auth=await client.authenticate(sign);socket=auth.s;check(auth.auth[2]===true,'Member AUTH denied');
    const publish=async(e:any)=>{socket!.send(['EVENT',e]);const ack=await socket!.next();
      check(ack[0]==='OK' && ack[1]===e.id && ack[2]===true,'Publication denied; inspect private result');
      evidence.steps.push({kind:e.kind,id:e.id,ack});save();};
    // Retain exact signed events for readback/resume inspection, never auth tokens.
    const eventFile=directory+'/signed-events.json';
    check(!existsSync(eventFile),'Publication attempt exists; inspect previous result before resuming');
    writeFileSync(eventFile,JSON.stringify(signed,null,2),{mode:0o600});
    await publish(signed[0]);await publish(signed[1]);
    await git(['push','--porcelain',c.root,`${c.base}:refs/heads/main`,`${c.head}:refs/heads/${c.branch}`],staging,await credential());
    evidence.steps.push('Explicit two-ref Smart HTTP push completed');save();
    await publish(signed[2]);socket.close();socket=undefined;
    let events:any[]=[];
    for(let attempt=0;attempt<5;attempt++){
      events=await client.events(sign,{ids:signed.map(e=>e.id)});
      if(signed.every(e=>events.some(x=>x.id===e.id)))break;
      await new Promise(r=>setTimeout(r,1000));
    }
    check(signed.every(e=>events.some(x=>x.id===e.id && JSON.stringify(x.tags)===JSON.stringify(e.tags) && x.content===e.content && x.pubkey===c.pubkey)),'Exact private event readback incomplete');
    const prs=await client.events(sign,{kinds:[1618],'#a':[`30617:${c.pubkey}:${c.identifier}`]});
    check(prs.some(e=>e.id===signed[2].id),'PR list readback incomplete');
    const readback=directory+'/readback.git';check(!existsSync(readback),'Readback directory exists');mkdirSync(readback,{mode:0o700});
    await git(['init','--bare'],readback);
    await git(['fetch','--no-tags',c.root,'refs/heads/main:refs/heads/main',`refs/heads/${c.branch}:refs/heads/${c.branch}`],readback,await credential());
    check(await git(['rev-parse','refs/heads/main'],readback)===c.base && await git(['rev-parse','refs/heads/'+c.branch],readback)===c.head,'Remote base/head mismatch');
    check(await git(['diff','--no-ext-diff','--no-textconv','--binary','--full-index',c.base,c.head],readback)===patch,'Remote diff mismatch');
    await git(['fsck','--full'],readback);
    const relaySegment=encodeURIComponent('ws:'+c.relay.slice(5).replace(/\/$/,''));
    evidence.url=c.frontend+`/${c.actor}/${relaySegment}/${c.identifier}/prs/${signed[2].id}`;
    evidence.steps.push({privateEvents:events.map(e=>e.id),prList:true,gitFilesAndDiff:true,base:c.base,head:c.head});
    evidence.browserVerification='Pending native host UI: open URL, approve service and authentication, verify PR list/detail/files/diff. No fake reviewer identity.';
    save();console.log(JSON.stringify(evidence,null,2));
  }
} catch(error) {
  evidence.error=error instanceof Error && /^(Git |Publication |Anonymous |Remote |Exact |PR |Member |No private |Unexpected |Publication attempt |Import staging |Readback directory)/.test(error.message)?error.message:safeBrokerError(error);
  save();console.error(JSON.stringify({ok:false,error:evidence.error,result:directory+'/result.json'}));process.exitCode=1;
} finally {socket?.close();}
