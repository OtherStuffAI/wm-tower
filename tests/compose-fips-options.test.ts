import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('rejects deployments without FIPS settings or with FIPS disabled', async () => {
  for (const enabled of [undefined, 'false']) {
    const result = await options({ enabled });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ERROR:');
  }
});

test('rejects missing requested files and inconsistent FIPS configuration before deployment', async () => {
  for (const input of [{ explicitMissing: true }, { enabled: 'true' }, { enabled: 'invalid', overlay: true }]) {
    const result = await options(input);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('ERROR:');
  }
});

async function deploy(args: string[], failMeshHealth = false) {
  const directory = mkdtempSync(join(tmpdir(), 'tower-deploy-fips-'));
  try {
    mkdirSync(join(directory, 'docker'));
    mkdirSync(join(directory, 'bin'));
    copyFileSync(helper, join(directory, 'docker/compose-fips-options.sh'));
    copyFileSync(join(import.meta.dir, '../rebuild_deploy_docker.sh'), join(directory, 'deploy.sh'));
    writeFileSync(join(directory, '.env.prod'), 'TOWER_HOST_PORT=3100\n');
    writeFileSync(join(directory, 'docker-compose.prod.yml'), 'services: {}\n');
    writeFileSync(join(directory, 'docker-compose.fips.yml'), 'services: {}\n');
    writeFileSync(join(directory, '.env.fips'),
      'TOWER_FIPS_ENABLED=true\nTOWER_FIPS_NODE_NPUB=test-node\nTOWER_FIPS_MESH_ADDRESS=fd00::1\nTOWER_FIPS_PORT=43100\n');
    const log = join(directory, 'commands.log');
    writeFileSync(join(directory, 'docker/ensure-bun-base.sh'),
      '#!/usr/bin/env bash\nprintf "test-bun-base\\n"\n', { mode: 0o755 });
    for (const command of ['docker', 'bun', 'curl']) {
      writeFileSync(join(directory, 'bin', command),
        `#!/usr/bin/env bash\nprintf '%s %s\\n' '${command}' "$*" >> "$TOWER_TEST_COMMAND_LOG"\n`
        + (command === 'curl' ? 'if [[ "$TOWER_TEST_FAIL_MESH" == true && "$*" == *"http://[fd00::1]"* ]]; then exit 22; fi\n' : ''),
        { mode: 0o755 });
    }
    const process = Bun.spawn(['bash', 'deploy.sh', ...args], {
      cwd: directory, stdout: 'pipe', stderr: 'pipe',
      env: { ...Bun.env, PATH: `${join(directory, 'bin')}:${Bun.env.PATH}`,
        ENV_FILE: '.env.prod', COMPOSE_FILE: 'docker-compose.prod.yml',
        FIPS_ENV_FILE: '.env.fips', FIPS_COMPOSE_FILE: 'docker-compose.fips.yml',
        TOWER_TEST_COMMAND_LOG: log, TOWER_TEST_FAIL_MESH: String(failMeshHealth) },
    });
    const [exitCode, stdout] = await Promise.all([
      process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
    ]);
    return { exitCode, stdout, commands: readFileSync(log, 'utf8').trim().split('\n') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('all rebuild paths keep FIPS in every Compose command and verify mesh health', async () => {
  for (const args of [[], ['--no-cache'], ['--refresh-bun-base'], ['--down']]) {
    const result = await deploy(args);
    expect(result.exitCode).toBe(0);
    const compose = result.commands.filter(command => command.startsWith('docker compose --env-file'));
    expect(compose.length).toBeGreaterThanOrEqual(4);
    for (const command of compose) {
      expect(command).toContain('--env-file .env.fips -f docker-compose.fips.yml');
    }
    expect(result.commands.some(command => command.startsWith('curl ') && command.includes('http://[fd00::1]:43100/health'))).toBe(true);
    expect(result.stdout).toContain('==> Done');
  }
});

test('failed FIPS health prevents deployment from reporting success', async () => {
  const result = await deploy([], true);
  expect(result.exitCode).toBe(22);
  expect(result.stdout).not.toContain('==> Done');
});
