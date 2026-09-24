import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey } from 'nostr-tools';
import { createFipsHostGateway } from '../../src/fips-host-gateway';
const host = `${process.env.TOWER_FIPS_NODE_NPUB}.fips:${process.env.TOWER_FIPS_PORT}`;
const path = '/exact%2Fpath?z=2&a=1';
const body = 'actual macOS TCP -> Docker loopback publish -> canonical NIP98 ingress';
const key = generateSecretKey();
function auth(origin: string) {
  const event = finalizeEvent({kind:27235, created_at:Math.floor(Date.now()/1000), content:'', tags:[['u',origin+path],['method','POST'],['payload',createHash('sha256').update(body).digest('hex')]]},key);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}
const gateway = createFipsHostGateway();
gateway.server.listen({host:'::1',port:0,ipv6Only:true});
await once(gateway.server,'listening');
try {
  const port = (gateway.server.address() as {port:number}).port;
  for (const [requestHost, origin, expected] of [[host,`http://${host}`,200],[host,'https://sb4.otherstuff.studio',401],['wrong.example',`http://${host}`,421]] as const) {
    const r=await fetch(`http://[::1]:${port}${path}`,{method:'POST',body,headers:{host:requestHost,authorization:auth(origin),'x-forwarded-proto':'https','x-forwarded-host':'sb4.otherstuff.studio'},signal:AbortSignal.timeout(3000)});
    if(r.status!==expected) throw new Error(`Expected ${expected}, got ${r.status}`);
    const text=await r.text();
    if(expected===200&&text!==body) throw new Error('Body changed');
    console.log(`PASS actual host -> Docker: HTTP ${expected}`);
  }
} finally { gateway.stop(); }
