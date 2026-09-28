import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helper = join(import.meta.dir, '../docker/compose-fips-options.sh');

async function options(input: { enabled?: string; overlay?: boolean; explicitMissing?: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), 'tower-compose-fips-'));
  try {
    if (input.enabled !== undefined) writeFileSync(join(directory, '.env.fips'), `TOWER_FIPS_ENABLED=${input.enabled}\n`);
    if (input.overlay) writeFileSync(join(directory, 'docker-compose.fips.yml'), 'services: {}\n');
    const process = Bun.spawn(['bash', '-c',
      'set -euo pipefail; COMPOSE=(docker compose --env-file .env.prod -f docker-compose.prod.yml); source "$1"; if [[ "$2" == true ]]; then FIPS_ENV_FILE=missing.env; fi; append_tower_fips_options; printf "%s\\n" "${COMPOSE[@]}"',
      'compose-test', helper, String(input.explicitMissing ?? false)], {
      cwd: directory, stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
    ]);
    return { exitCode, args: stdout.trim().split('\n'), stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('preserves enabled FIPS environment and ingress on deployment commands', async () => {
  const result = await options({ enabled: 'true', overlay: true });
  expect(result.exitCode).toBe(0);
  expect(result.args).toEqual(['docker', 'compose', '--env-file', '.env.prod', '-f', 'docker-compose.prod.yml',
    '--env-file', '.env.fips', '-f', 'docker-compose.fips.yml']);
});

test('leaves installations without FIPS or with explicitly disabled FIPS unchanged', async () => {
  for (const enabled of [undefined, 'false']) {
    const result = await options({ enabled });
    expect(result.exitCode).toBe(0);
    expect(result.args).toEqual(['docker', 'compose', '--env-file', '.env.prod', '-f', 'docker-compose.prod.yml']);
  }
});

test('rejects missing requested files and inconsistent FIPS configuration before deployment', async () => {
  for (const input of [{ explicitMissing: true }, { enabled: 'true' }, { enabled: 'invalid', overlay: true }]) {
    const result = await options(input);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ERROR:');
  }
});
