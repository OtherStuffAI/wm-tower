// macOS per-process FIPS transport outage; never stops the host bridge/service.
// Pair with destination-spy.test.ts: the sandbox proves canonical failure,
// while the native spy proves alternate destinations are rejected before dialing.
import {command,check} from './gate-client';
import {mkdtemp,writeFile,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
const cfg=JSON.parse(await Bun.file(process.argv[2]).text());
const evidence=resolve(cfg.evidence);
check((await command(['git','check-ignore',evidence])).trim()===evidence,'ignored evidence required');
const cache=await mkdtemp(evidence+'/unavailable-native-cache-');await chmod(cache,0o700);
const env={...process.env};
for(const key of Object.keys(env))if(/^(GIT_|NGIT_)/.test(key))delete env[key];
Object.assign(env,{PATH:cfg.ngitBin+':'+process.env.PATH,NGIT_POC_PRIVATE_SERVICE:'1',NGIT_CACHE_DIR:cache,NGIT_REPO_RELAY_ONLY:'1',NGIT_TOR_PROXY:'off',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'});
const port=Number(new URL(cfg.relay).port);check(Number.isInteger(port)&&port>0,'explicit relay port required');
const profile=`(version 1)(allow default)(deny network-outbound (remote tcp "*:${port}"))`;
const npub=new URL(cfg.root).pathname.split('/')[1];
const remote='nostr://'+npub+'/'+encodeURIComponent(cfg.relay)+'/synthetic';
const at=new Date().toISOString();
const transport=Bun.spawn(['/usr/bin/sandbox-exec','-p',profile,'curl','--max-time','3','--silent','--output','/dev/null',new URL(cfg.root).origin+'/'],{stdout:'ignore',stderr:'ignore'});
check(await transport.exited===7,'sandbox did not reject canonical connection');
const p=Bun.spawn(['/usr/bin/sandbox-exec','-p',profile,'git','ls-remote',remote],{env,cwd:evidence,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
let timedOut=false;const timer=setTimeout(()=>{timedOut=true;p.kill();},45000);
const [stdout,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);clearTimeout(timer);
await writeFile(evidence+'/native-unavailable-output.log',stdout+'\n'+stderr,{mode:0o600});
check(code!==0&&!stdout.includes('refs/heads/main'),'uncached outage unexpectedly resolved repository');
check(!timedOut,'uncached client did not terminate within 45 seconds');
check(stderr.includes('no repo announcement event found'),'unexpected unavailable-client failure');
const restored=Bun.spawn(['git','ls-remote',remote],{env,cwd:evidence,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
const recoveryTimer=setTimeout(()=>restored.kill(),45000);
const [restoredOut,restoredErr,restoredCode]=await Promise.all([new Response(restored.stdout).text(),new Response(restored.stderr).text(),restored.exited]);clearTimeout(recoveryTimer);
check(restoredCode===0&&restoredOut.includes(cfg.main+'\trefs/heads/main'),'native transport recovery control failed');
const result={at,finished:new Date().toISOString(),profile,cacheInitiallyEmpty:true,command:['git','ls-remote',remote],code,timedOut,stdout,error:stderr.trim(),sandboxCurlExit:7,recovery:{code:restoredCode,refs:restoredOut},passed:true,scope:'native uncached per-process canonical FIPS port unavailable; host connectivity unchanged; alternate destination pre-network rejection independently covered by native destination spy'};
await writeFile(evidence+'/native-unavailable.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
