// Signing-only live gate. Signed fixtures contain fake refs: never persist or publish them.
import { candidates, clone, relay, type Candidate } from './signing-policy-candidates';
import { validateSignedResponse, safeBrokerError } from './signed-response';
const autopilot = process.env.AUTOPILOT_REPO ?? '/Users/mini/code/wm/autopilot';
const { callCapabilityBroker, readCapabilityIdentity } = await import(`${autopilot}/src/mcp/capability-client.ts`);
const { verifyEvent } = await import(`${autopilot}/node_modules/nostr-tools/lib/esm/index.js`);
const actor = 'npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr';
const identity = await readCapabilityIdentity().catch((error: unknown) => {
  console.error(JSON.stringify({error:safeBrokerError(error)}));
  process.exit(1);
});
if (identity.botNpub !== actor) throw new Error('Unexpected broker actor');
const results: object[] = [];
async function check(name: string, allowed: boolean, path: string, body: object) {
  let signed = false;
  let error: string | undefined;
  try {
    const created_at = Math.floor(Date.now()/1000);
    const result = await callCapabilityBroker(path, body);
    if (path.endsWith('nostr-event')) {
      if (result.signerNpub !== actor) throw new Error('Invalid signer');
      validateSignedResponse(result.event, {...(body as any).event, pubkey:identity.botPubkeyHex,created_at}, verifyEvent);
    } else {
      if (result.signedBy !== actor || typeof result.token !== 'string' || !result.token.startsWith('Nostr ')) throw new Error('Invalid HTTP signing response');
      const event = JSON.parse(Buffer.from(result.token.slice(6),'base64').toString());
      validateSignedResponse(event, {pubkey:identity.botPubkeyHex,created_at,kind:27235,content:'',tags:[['u',(body as any).url],['method',(body as any).method]]},verifyEvent,process.env.SESSION_ID);
    }
    signed = true;
  } catch (e) { error = safeBrokerError(e); }
  const passed = allowed ? signed : !signed && /^NIP-98 .*not allowed$|^Nostr event (violates an exact tag constraint|tag is not allowed|kind is not allowed|tags exceed policy)$/.test(error ?? '');
  results.push({ name, expected: allowed ? 'allow' : 'deny', signed, passed, ...(error ? {error} : {}) });
}
const http = '/api/mcp/capabilities/nip98';
await check('canonical root GET', true, http, {url:clone, method:'GET'});
for (const [name,url,method] of [
  ['wrong origin', clone.replace(':41007', ':41008'), 'GET'],
  ['wrong repository', clone.replace('synthetic.git','other.git'), 'GET'],
  ['wrong path', `${clone}/info/refs`, 'GET'],
  ['wrong method', clone, 'POST'],
]) await check(name, false, http, {url, method});
const nostr = '/api/mcp/capabilities/nostr-event';
for (const candidate of candidates()) {
  await check(`kind ${candidate.kind} candidate`, true, nostr, {event:candidate});
  const change = async (name: string, mutate: (c: Candidate)=>void) => {
    const event = structuredClone(candidate); mutate(event);
    await check(`kind ${event.kind} ${name}`, false, nostr, {event});
  };
  if (candidate.kind !== 22242) {
    await change('duplicate d', e=>e.tags.push(['d','other']));
    await change('duplicate d reversed', e=>e.tags.unshift(['d','other']));
    await change('missing d', e=>{e.tags=e.tags.filter(t=>t[0]!=='d');});
    await change('wrong repository', e=>{e.tags.find(t=>t[0]==='d')![1]='other';});
  }
  for (const tag of candidate.kind===22242 ? ['relay'] : candidate.kind===30617 ? ['relays','clone'] : []) {
    await change(`extra ${tag} value`, e=>e.tags.find(t=>t[0]===tag)!.push(tag==='clone' ? clone+'/other' : relay+'other'));
    await change(`duplicate ${tag}`, e=>e.tags.push([...e.tags.find(t=>t[0]===tag)!]));
  }
}
console.log(JSON.stringify({ at:new Date().toISOString(), sessionId:process.env.SESSION_ID, signedBy:actor,
  evidence:'Signing only; no fixture published or retained; no Git request', results },null,2));
if (results.some((r:any)=>!r.passed)) process.exitCode=1;
