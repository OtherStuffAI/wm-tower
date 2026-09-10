// Run with Bun. Uses only this session's capability; never prints credentials.
const autopilot = process.env.AUTOPILOT_REPO ?? '/Users/mini/code/wm/autopilot';
const { callCapabilityBroker } = await import(`${autopilot}/src/mcp/capability-client.ts`);
const routing = await Bun.file(new URL('./fips.json', import.meta.url)).json();
const repository = new URL(process.argv[2] ?? new URL('/npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr/synthetic.git', routing.url).href);
if (repository.username || repository.password || repository.search || repository.hash
  || !repository.pathname.endsWith('/synthetic.git')) throw new Error('Expected synthetic repository root');
try {
  const result = await callCapabilityBroker('/api/mcp/capabilities/nip98', { url: repository.href, method: 'GET' });
  if (result.signedBy !== 'npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr') {
    throw new Error('Unexpected broker actor');
  }
  console.log(JSON.stringify({ ok: true, signedBy: result.signedBy, repository: repository.href,
    evidence: 'credential signing only; no Git request performed' }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, repository: repository.href, error: (error as Error).message }));
  process.exitCode = 1;
}
