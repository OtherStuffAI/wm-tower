import { readFileSync } from 'node:fs';

const root = new URL('./console/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const css = readFileSync(new URL('style.css', root), 'utf8');
const script = readFileSync(new URL('client.js', root), 'utf8');

export function buildNstackConsoleHtml(apiBaseUrl: string) {
  return html.replace('/* CONSOLE_STYLE */', css)
    .replace('/* CONSOLE_SCRIPT */', () => script.replace('"__API_BASE__"', () => JSON.stringify(apiBaseUrl).replaceAll('<', '\\u003c')));
}

// Deliberately closed asset list: never expose arbitrary repository files.
export function consoleAsset(name: string) {
  if (!['nstack-horizontal-white.svg', 'InterVariable.ttf', 'Inter-OFL.txt', 'crypto.js', 'crypto-LICENSE.txt'].includes(name)) return null;
  return Bun.file(new URL('assets/' + name, root));
}
