// Discovery and anonymous denials only. This does not prove populated-repo privacy.
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:60546');
const actor = 'npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr';
const discovery = await fetch(origin, { headers: { Accept: 'application/nostr+json' }, signal: AbortSignal.timeout(5000) });
const nip11 = await discovery.json();
if (!discovery.ok || !nip11.supported_nips?.includes(42) || !nip11.supported_nips?.includes(98)
  || !nip11.supported_grasps?.includes('GRASP-08')) throw new Error('Private discovery requirements missing');
for (const suffix of ['info/refs?service=git-upload-pack', 'HEAD', 'objects/info/packs', 'git-upload-pack']) {
  const response = await fetch(new URL(`/${actor}/synthetic.git/${suffix}`, origin), {
    method: suffix === 'git-upload-pack' ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 401 || (await response.arrayBuffer()).byteLength !== 0
    || !response.headers.get('www-authenticate')?.startsWith('Nostr')) throw new Error(`Anonymous Git denial failed: ${suffix}`);
}
const relay = new URL(origin); relay.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
await new Promise<void>((resolve, reject) => {
  const ws = new WebSocket(relay);
  const finish = (error?: Error) => { clearTimeout(timer); ws.close(); error ? reject(error) : resolve(); };
  const timer = setTimeout(() => finish(new Error('Anonymous relay test timed out')), 5000);
  ws.onerror = () => finish(new Error('Relay transport failed'));
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message[0] === 'AUTH') ws.send(JSON.stringify(['REQ', 'poc-anonymous', { kinds: [30617, 30618, 1621, 1617] }]));
    else if (message[0] === 'CLOSED' && message[1] === 'poc-anonymous' && String(message[2]).startsWith('auth-required:')) finish();
    else finish(new Error(`Unexpected anonymous relay response: ${message[0]}`));
  };
});
console.log(JSON.stringify({ origin: origin.origin, discovery: 'pass', anonymousGit: 'pass', anonymousRelay: 'pass',
  servicePubkey: nip11.pubkey, version: nip11.version,
  limitation: 'No authenticated synthetic content or distinct-peer test; not acceptance of gate 2 or 3' }, null, 2));
