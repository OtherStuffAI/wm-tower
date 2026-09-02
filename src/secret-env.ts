import { readFileSync } from 'node:fs';

export function secretEnv(name: string): string {
  const direct = String(process.env[name] || '').trim();
  const file = String(process.env[`${name}_FILE`] || '').trim();
  if (direct && file) throw new Error(`${name} and ${name}_FILE cannot both be set`);
  if (!file) return direct;
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error(`${name}_FILE could not be read`);
  }
}
