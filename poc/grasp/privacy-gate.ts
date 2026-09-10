// Populated synthetic service only. Ephemeral nonmember fixture keys never leave memory.
import {clone,relay} from './signing-policy-candidates';
import {validateSignedResponse,safeBrokerError} from './signed-response';
async function main() {
const autopilot=process.env.AUTOPILOT_REPO ?? '/Users/mini/code/wm/autopilot';
const {callCapabilityBroker,readCapabilityIdentity}=await import(`${autopilot}/src/mcp/capability-client.ts`);
const {generateSecretKey,finalizeEvent,verifyEvent}=await import(`${autopilot}/node_modules/nostr-tools/lib/esm/index.js`);
const identity=await readCapabilityIdentity();
if(identity.botPubkeyHex!=='ffdc30446bede234446a69124bae94cdbddebf24f0abee4a5cabfc1124313c2e') throw new Error('Wrong actor');
const expectedMain=process.argv[2];
if(!/^[0-9a-f]{40}$/.test(expectedMain ?? '')) throw new Error('Expected actual synthetic main OID');
const results:object[]=[];
const created_at=Math.floor(Date.now()/1000);
const member=await callCapabilityBroker('/api/mcp/capabilities/nip98',{url:clone,method:'GET'});
validateSignedResponse(JSON.parse(Buffer.from(member.token.slice(6),'base64').toString()),{kind:27235,created_at,content:'',tags:[['u',clone],['method','GET']],pubkey:identity.botPubkeyHex},verifyEvent,process.env.SESSION_ID);
const nonmemberKey=generateSecretKey();
const nonmemberEvent=finalizeEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',clone],['method','GET']]},nonmemberKey);
const nonmemberToken='Nostr '+Buffer.from(JSON.stringify(nonmemberEvent)).toString('base64');
for(const [name,url,authorization,status] of [
  ['member discovery',clone+'/info/refs?service=git-upload-pack',member.token,200],
  ['anonymous discovery',clone+'/info/refs?service=git-upload-pack','',401],
  ['nonmember discovery',clone+'/info/refs?service=git-upload-pack',nonmemberToken,401],
  ['member token wrong repository',clone.replace('synthetic.git','other.git')+'/info/refs?service=git-upload-pack',member.token,401],
  ['invalid authorization',clone+'/HEAD','Nostr invalid',401],
] as const) {
  const response=await fetch(url,{headers:authorization?{authorization}:{},redirect:'manual',signal:AbortSignal.timeout(5000)});
  const bytes=await response.arrayBuffer();
  if(response.status!==status || (status===401 && bytes.byteLength!==0)) throw new Error(name+' failed');
  if(status===200 && !new TextDecoder().decode(bytes).includes(expectedMain)) throw new Error('Member advertisement lacks expected main');
  results.push({name,status:response.status,bytes:bytes.byteLength,passed:true});
}
async function relayCheck(mode:'member'|'nonmember'|'anonymous') {
  const events:any[]=[];
  let authorized=false, denied=false;
  await new Promise<void>((resolve,reject)=>{
    const ws=new WebSocket(relay);
    let finished=false;
    const finish=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);ws.close();error?reject(error):resolve();};
    const timer=setTimeout(()=>finish(new Error(mode+' relay timeout')),7000);
    ws.onerror=()=>finish(new Error(mode+' relay transport error'));
    ws.onmessage=async({data})=>{try{
      const m=JSON.parse(String(data));
      if(m[0]==='AUTH') {
        if(mode==='anonymous') {ws.send(JSON.stringify(['REQ','synthetic',{kinds:[30617,30618],authors:[identity.botPubkeyHex],'#d':['synthetic']}]));return;}
        const candidate={kind:22242,content:'',tags:[['relay',relay],['challenge',m[1]]],created_at:Math.floor(Date.now()/1000)};
        const event=mode==='member'?(await callCapabilityBroker('/api/mcp/capabilities/nostr-event',{event:candidate})).event:finalizeEvent(candidate,nonmemberKey);
        if(mode==='member') validateSignedResponse(event,{...candidate,pubkey:identity.botPubkeyHex},verifyEvent);
        ws.send(JSON.stringify(['AUTH',event]));
      } else if(m[0]==='OK') {
        if(mode==='nonmember') {if(m[2]!==false) throw new Error('Nonmember AUTH accepted');denied=true;finish();}
        else {if(m[2]!==true) throw new Error('Member AUTH denied');authorized=true;ws.send(JSON.stringify(['REQ','synthetic',{kinds:[30617,30618],authors:[identity.botPubkeyHex],'#d':['synthetic']}]));}
      } else if(m[0]==='EVENT') {
        if(mode!=='member' || !authorized) throw new Error('Repository event leaked before member auth');
        if(m[2].pubkey!==identity.botPubkeyHex || ![30617,30618].includes(m[2].kind) || !m[2].tags.some(t=>t[0]==='d' && t[1]==='synthetic') || !verifyEvent(m[2])) throw new Error('Invalid repository event signature');
        events.push(m[2]);
      } else if(m[0]==='EOSE') finish();
      else if(m[0]==='CLOSED' && mode==='anonymous' && String(m[2]).startsWith('auth-required:')) {denied=true;finish();}
      else throw new Error('Unexpected relay response '+m[0]);
    }catch(error){finish(new Error(safeBrokerError(error)));}};
  });
  if(mode!=='member' && !denied) throw new Error('Expected explicit relay denial');
  if(mode==='member' && (!authorized)) throw new Error('Expected member authorization');
  if(mode==='member' && (!events.some(e=>e.kind===30617) || !events.some(e=>e.kind===30618 && e.tags.some(t=>t[0]==='refs/heads/main' && t[1]===expectedMain)))) throw new Error('Accepted repo/state absent');
  return {name:mode+' relay',passed:true,eventCount:events.length};
}
for(const mode of ['anonymous','nonmember','member'] as const) results.push(await relayCheck(mode));
console.log(JSON.stringify({at:new Date().toISOString(),expectedMain,results,scope:'Populated synthetic same-host canonical FIPS only; distinct-peer/read-only-member/removal/expiry not tested'},null,2));
}
await main().catch(error=>{console.error(JSON.stringify({error:safeBrokerError(error)}));process.exitCode=1;});
