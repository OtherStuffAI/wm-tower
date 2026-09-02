import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TowerBuildInfo {
  name: string;
  version: string | null;
  git_commit: string | null;
  git_branch: string | null;
  build_time: string | null;
  runtime: string;
}

function firstEnv(...names: string[]) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return null;
}

function readPackageVersion() {
  try {
    const packagePath = join(process.cwd(), 'package.json');
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8'));
    return typeof parsed?.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function readGitHead() {
  try {
    const gitDir = join(process.cwd(), '.git');
    const headPath = join(gitDir, 'HEAD');
    if (!existsSync(headPath)) return { commit: null, branch: null };

    const head = readFileSync(headPath, 'utf8').trim();
    if (!head.startsWith('ref: ')) return { commit: head || null, branch: null };

    const ref = head.slice(5).trim();
    const refPath = join(gitDir, ref);
    const commit = existsSync(refPath) ? readFileSync(refPath, 'utf8').trim() : null;
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    return { commit: commit || null, branch };
  } catch {
    return { commit: null, branch: null };
  }
}

export function getTowerBuildInfo(): TowerBuildInfo {
  const gitHead = readGitHead();
  return {
    name: 'wingman-tower',
    version: firstEnv('TOWER_VERSION', 'APP_VERSION', 'npm_package_version') || readPackageVersion(),
    git_commit: firstEnv(
      'TOWER_GIT_COMMIT',
      'TOWER_GIT_SHA',
      'GIT_COMMIT',
      'GIT_SHA',
      'SOURCE_VERSION',
      'COMMIT_SHA',
      'CAPROVER_GIT_COMMIT',
    ) || gitHead.commit,
    git_branch: firstEnv('TOWER_GIT_BRANCH', 'GIT_BRANCH', 'BRANCH_NAME') || gitHead.branch,
    build_time: firstEnv('TOWER_BUILD_TIME', 'BUILD_TIME', 'BUILD_DATE', 'SOURCE_BUILD_TIME'),
    runtime: `bun ${Bun.version}`,
  };
}
