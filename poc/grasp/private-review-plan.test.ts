import {expect,test} from 'bun:test';
import {cleanGitEnvironment,validateReviewPlan,type ReviewPlan} from './private-review-plan';

function fixture():ReviewPlan {
  const actor='npub-test',pubkey='a'.repeat(64),identifier='review',base='1'.repeat(40),head='2'.repeat(40),rootOid='3'.repeat(40);
  const root=`http://service.fips:4000/${actor}/${identifier}.git`,relay='ws://service.fips:4000/';
  return {actor,pubkey,identifier,base,head,rootOid,root,relay,branch:'pr/change',source:'/tmp/source',frontend:'https://review.example.invalid',events:[
    {kind:30617,content:'',tags:[['d',identifier],['name',identifier],['private','true'],['relays',relay],['clone',root],['web'],['r',rootOid,'euc'],['alt','git repository: '+identifier],['description','Upstream attribution']]},
    {kind:30618,content:'',tags:[['d',identifier],['HEAD','ref: refs/heads/main'],['refs/heads/main',base],['refs/heads/pr/change',head]]},
    {kind:1618,content:'Review body',tags:[['a',`30617:${pubkey}:${identifier}`,relay],['p',pubkey],['r',rootOid],['c',head],['clone',root],['merge-base',base],['branch-name','change'],['subject','Change'],['alt','git Pull Request: Change']]},
  ]};
}
test('accepts exact two-ref private review plan',()=>expect(validateReviewPlan(fixture()).events).toHaveLength(3));
test('rejects public destinations, anonymous contributor lane, credentials and synthetic reuse',()=>{
  for(const mutate of [
    (c:ReviewPlan)=>{c.root=c.root.replace('service.fips','example.com');},
    (c:ReviewPlan)=>{c.root=c.root.replace('/npub-test/','/prs/npub-test/');},
    (c:ReviewPlan)=>{c.root+='?target=elsewhere';},
    (c:ReviewPlan)=>{c.relay='wss://public.example.invalid/';},
    (c:ReviewPlan)=>{c.identifier='synthetic';},
    (c:ReviewPlan)=>{c.root=c.root.replace('http://','http://' + 'user:pass@');},
  ]){const c=fixture();mutate(c);expect(()=>validateReviewPlan(c)).toThrow();}
});
test('rejects cross-coordinate PRs, changed refs, extra destinations and duplicate tags',()=>{
  for(const mutate of [
    (c:ReviewPlan)=>{c.events[2].tags[0][1]='30617:other:review';},
    (c:ReviewPlan)=>{c.events[2].tags.find(t=>t[0]==='c')![1]=c.base;},
    (c:ReviewPlan)=>{c.events[1].tags[3][0]='refs/heads/hosting';},
    (c:ReviewPlan)=>{c.events[0].tags.find(t=>t[0]==='relays')!.push('wss://public.example.invalid');},
    (c:ReviewPlan)=>{c.events[2].tags.push(['clone',c.root]);},
    (c:ReviewPlan)=>{c.events.push({kind:1619,content:'',tags:[]});},
  ]){const c=fixture();mutate(c);expect(()=>validateReviewPlan(c)).toThrow();}
});
test('Git children do not inherit broker credentials, proxying, tracing or caller config',()=>{
  const env=cleanGitEnvironment({PATH:'/usr/bin',WINGMAN_CAPABILITY:'secret',SESSION_ID:'secret',GIT_TRACE_CURL:'1',GIT_CONFIG_COUNT:'1',GIT_CONFIG_VALUE_0:'unsafe',NGIT_REPO_RELAY_ONLY:'0',HTTPS_PROXY:'https://elsewhere',all_proxy:'elsewhere'});
  expect(env.PATH).toBe('/usr/bin');
  for(const key of ['WINGMAN_CAPABILITY','SESSION_ID','GIT_TRACE_CURL','NGIT_REPO_RELAY_ONLY','HTTPS_PROXY','all_proxy'])expect(key in env).toBe(false);
  expect(env.GIT_CONFIG_VALUE_0).toBe('false');expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
});
