// Explicit synthetic PoC commands only. Contains no keys, public destinations or arbitrary command mode.
import {mkdirSync,existsSync} from 'node:fs';
import {clone,relay} from './signing-policy-candidates';
const root='/Users/mini/code/wm/tower/.runtime/grasp-synthetic';
const upstream='/Users/mini/code/ngit-poc/ngit/target/debug';
const source=root+'/source';
const nostr='nostr://npub1llwrq3rtah3rg3r2dyfyht55ek7aa0ey7z47ujju407pzfp38shqa7zcvr/'+encodeURIComponent(relay)+'/synthetic';
const inherited={...process.env};
for(const key of Object.keys(inherited)) if (/^(GIT_|NGIT_)/.test(key)) delete inherited[key];
const env={...inherited, PATH:upstream+':'+process.env.PATH, NGIT_POC_PRIVATE_SERVICE:'1',
  NGIT_CACHE_DIR:root+'/cache', NGIT_REPO_RELAY_ONLY:'1', NGIT_TOR_PROXY:'off', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null',
  GIT_AUTHOR_NAME:'Synthetic PoC',GIT_AUTHOR_EMAIL:'synthetic@example.invalid',GIT_COMMITTER_NAME:'Synthetic PoC',GIT_COMMITTER_EMAIL:'synthetic@example.invalid',
  GIT_TERMINAL_PROMPT:'0'};
async function run(args:string[],cwd:string) {
  const child=Bun.spawn(args,{cwd,env,stdin:'ignore',stdout:'inherit',stderr:'inherit'});
  const timer=setTimeout(()=>child.kill(),90000);
  const code=await child.exited; clearTimeout(timer);
  if(code!==0) throw new Error('Synthetic command failed with exit '+code);
}
const action=process.argv[2];
if(action==='init' || action==='resume-init') {
  if(action==='init') {
  if(existsSync(source) || existsSync(root+'/cache')) throw new Error('Synthetic source or cache already exists; inspect before resuming');
  mkdirSync(source,{recursive:true,mode:0o700});
  await run(['git','init','--initial-branch=main'],source);
  await Bun.write(source+'/README.md','# Synthetic private GRASP PoC\nNo real project content.\n');
  await run(['git','add','README.md'],source);
  await run(['git','commit','-m','test: create synthetic root'],source);
  }
  const inspect=(args:string[])=>{const r=Bun.spawnSync(['git',...args],{cwd:source,env}); if(r.exitCode!==0) throw new Error('Source verification failed'); return r.stdout.toString().trim();};
  if(inspect(['for-each-ref','--format=%(refname)'])!=='refs/heads/main' || inspect(['remote'])!=='' || inspect(['symbolic-ref','HEAD'])!=='refs/heads/main') throw new Error('Expected fresh main-only source with no remotes');
  await run([upstream+'/ngit','init','--private','--name','synthetic','--identifier','synthetic','--description','Synthetic private PoC',
    '--grasp-server','','--additional-relay',relay,'--additional-clone',clone,'--repo-relay-only','--defaults','--json'],source);
} else if(action==='push') {
  // Explicit slash preserves the exact granted relay string through URL decoding.
  await run(['git','remote','set-url','origin',nostr],source);
  await run(['git','push','-u','origin','main'],source);
} else if(action==='clone') {
  if(existsSync(root+'/clone') || existsSync(root+'/clone-cache')) throw new Error('Clone/cache already exists');
  env.NGIT_CACHE_DIR=root+'/clone-cache';
  await run(['git','clone',nostr,root+'/clone'],root);
} else if(action==='update') {
  if(existsSync(source+'/second.txt')) throw new Error('Second commit already prepared');
  await Bun.write(source+'/second.txt','Synthetic update for fetch verification.\n');
  await run(['git','add','second.txt'],source);
  await run(['git','commit','-m','test: add synthetic fetch verification'],source);
  await run(['git','push','origin','main'],source);
} else if(action==='fetch') {
  env.NGIT_CACHE_DIR=root+'/clone-cache';
  await run(['git','fetch','origin'],root+'/clone');
  await run(['git','merge','--ff-only','origin/main'],root+'/clone');
} else throw new Error('Supported actions: init, resume-init, push, clone, update, fetch');
