import { config } from '../config';
import { getEffectiveRequestUrl } from '../auth';

/** Use Tower's configured public identity, never an internal proxy/FIPS origin. */
export function blossomPublicOrigin(request: Request): string {
  const explicit = config.storage.blossomPublicOrigin;
  const url = new URL(explicit || config.directHttpsUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.hostname.endsWith('.fips') || url.username || url.password || url.search || url.hash || (explicit && url.pathname !== '/'))
    throw new Error('Blossom publication requires a configured public HTTPS origin');
  // Source-router/local test fixtures keep their actual HTTP listener origin.
  if (!explicit && local) {
    const incoming = getEffectiveRequestUrl(request);
    if (['localhost', '127.0.0.1', '[::1]'].includes(incoming.hostname)) return incoming.origin;
  }
  return url.origin;
}
