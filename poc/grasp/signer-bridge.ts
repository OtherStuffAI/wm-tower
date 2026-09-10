// Private stdin/stdout protocol for the isolated ngit PoC adapter. Never run with tracing.
// This bridge signs only; it contains no relay/Git publication client.
import { clone, relay } from './signing-policy-candidates';
import { validateSignedResponse, safeBrokerError } from './signed-response';
const autopilot = process.env.AUTOPILOT_REPO ?? '/Users/mini/code/wm/autopilot';
const { callCapabilityBroker, readCapabilityIdentity } = await import(`${autopilot}/src/mcp/capability-client.ts`);
const { verifyEvent } = await import(`${autopilot}/node_modules/nostr-tools/lib/esm/index.js`);
try {
  const input = JSON.parse(await Bun.stdin.text());
  const identity = await readCapabilityIdentity();
  if (identity.botNpub !== 'npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr') throw new Error('Unexpected actor');
  if (input.operation === 'sign') {
    const event = input.event;
    if (event.pubkey !== identity.botPubkeyHex) throw new Error('Unexpected event actor');
    let signed;
    if (event.kind === 27235) {
      if (event.content !== '' || JSON.stringify(event.tags) !== JSON.stringify([['u',clone],['method','GET']])) throw new Error('HTTP candidate outside synthetic root GET');
      const {token} = await callCapabilityBroker('/api/mcp/capabilities/nip98', {url:clone, method:'GET'});
      signed = JSON.parse(Buffer.from(token.replace(/^Nostr /,''),'base64').toString());
    } else {
      // Diagnostic opt-in lets the native private-list gate reproduce the broker denial.
      // There is still no publication path; an unexpected allow stops the native gate.
      const discoveryProbe = process.env.NGIT_POC_PROBE_DISCOVERY === '1' && event.kind === 10318
        && Array.isArray(event.tags) && event.tags.length === 0 && typeof event.content === 'string' && event.content.length < 4096;
      if (![22242,30617,30618].includes(event.kind) && !discoveryProbe) throw new Error('Kind outside synthetic grant');
      signed = (await callCapabilityBroker('/api/mcp/capabilities/nostr-event', {event})).event;
    }
    // Autopilot owns created_at. Preserve every other requested signed field.
    validateSignedResponse(signed,event,verifyEvent,process.env.SESSION_ID);
    console.log(JSON.stringify({event:signed}));
  } else if (input.operation === 'encrypt-private-list') {
    if (input.peer !== identity.botPubkeyHex || input.content !== JSON.stringify([['g',relay]])) throw new Error('Encryption outside synthetic self discovery list');
    const result = await callCapabilityBroker('/api/mcp/capabilities/nip44/encrypt', {recipientPubkey:input.peer,plaintext:input.content});
    console.log(JSON.stringify(result));
  } else throw new Error('Unsupported bridge operation');
} catch (error) {
  console.error(JSON.stringify({error:safeBrokerError(error)}));
  process.exitCode=1;
}
