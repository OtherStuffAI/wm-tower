import { createFipsIngressFetch, readFipsIngressConfig } from '../../src/fips-ingress';
import { verifyNip98Auth } from '../../src/auth';
const config = readFipsIngressConfig(process.env)!;
Bun.serve({hostname: config.bindAddress, port: config.bindPort, idleTimeout: 0,
fetch: createFipsIngressFetch(config, async req => { const signer = await verifyNip98Auth(req); return new Response(await req.text(), {status: signer ? 200 : 401}); })});
