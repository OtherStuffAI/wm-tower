// Reusable private review contract. Operational coordinates live in ignored config.
export type EventTemplate = {kind: number; content: string; tags: string[][]};
export interface ReviewPlan {
  actor: string; pubkey: string; identifier: string; relay: string; root: string;
  base: string; head: string; rootOid: string; branch: string; source: string;
  frontend: string; events: EventTemplate[];
}
function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function validateReviewPlan(c: ReviewPlan) {
  requireValue(/^[0-9a-f]{64}$/.test(c.pubkey), 'Invalid public identity');
  requireValue(/^[a-z0-9-]+$/.test(c.identifier) && c.identifier !== 'synthetic', 'Invalid review identifier');
  for (const oid of [c.base,c.head,c.rootOid]) requireValue(/^[0-9a-f]{40}$/.test(oid), 'Invalid commit');
  requireValue(c.base !== c.head && /^pr\/[a-z0-9-]+$/.test(c.branch), 'Invalid review branch');
  const root=new URL(c.root), relay=new URL(c.relay);
  requireValue(root.protocol === 'http:' && root.hostname.endsWith('.fips') && root.port !== '', 'Private FIPS root required');
  requireValue(!root.username && !root.password && !root.search && !root.hash, 'Root credentials/query forbidden');
  requireValue(root.pathname === `/${c.actor}/${c.identifier}.git`, 'Root identity or repository mismatch');
  requireValue(relay.href === root.origin.replace('http:','ws:')+'/', 'Sole private relay must match Git origin');
  requireValue(new URL(c.frontend).protocol === 'https:', 'HTTPS frontend required');
  requireValue(c.events.length===3 && c.events.map(e=>e.kind).join(',')==='30617,30618,1618', 'Exact announcement/state/PR required');
  const [a,s,p]=c.events;
  const exact=(e:EventTemplate,name:string,values:string[])=>requireValue(
    e.tags.filter(t=>t[0]===name).length===1 && JSON.stringify(e.tags.find(t=>t[0]===name))===JSON.stringify([name,...values]),'Unexpected '+name+' tag');
  for (const e of c.events) {
    requireValue(e.tags.every(t=>t.length>0 && t.every(v=>typeof v==='string')),'Malformed tags');
    requireValue(new Set(e.tags.map(t=>t[0])).size===e.tags.length,'Duplicate tags');
  }
  requireValue(a.content==='' && s.content==='', 'Unexpected repository content');
  requireValue(a.tags.length===9 && s.tags.length===4 && p.tags.length===9, 'Unexpected event tags');
  exact(a,'d',[c.identifier]); exact(a,'name',[c.identifier]); exact(a,'private',['true']);
  exact(a,'relays',[c.relay]); exact(a,'clone',[c.root]); exact(a,'web',[]);
  exact(a,'r',[c.rootOid,'euc']); exact(a,'alt',['git repository: '+c.identifier]);
  requireValue(a.tags.some(t=>t[0]==='description' && t.length===2), 'Missing attribution');
  exact(s,'d',[c.identifier]); exact(s,'HEAD',['ref: refs/heads/main']);
  exact(s,'refs/heads/main',[c.base]); exact(s,'refs/heads/'+c.branch,[c.head]);
  exact(p,'a',[`30617:${c.pubkey}:${c.identifier}`,c.relay]); exact(p,'p',[c.pubkey]);
  exact(p,'r',[c.rootOid]); exact(p,'c',[c.head]); exact(p,'clone',[c.root]);
  exact(p,'merge-base',[c.base]); exact(p,'branch-name',[c.branch.slice(3)]);
  const subject=p.tags.find(t=>t[0]==='subject');
  requireValue(subject?.length===2 && subject[1].length>0, 'Missing PR title');
  exact(p,'alt',['git Pull Request: '+subject[1]]);
  return c;
}

export function cleanGitEnvironment(source: NodeJS.ProcessEnv) {
  const env={...source};
  for(const key of Object.keys(env)) if (/^(GIT_|NGIT_|WINGMAN_|AUTOPILOT_|SESSION_ID$)|proxy/i.test(key)) delete env[key];
  return {...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'4',
    GIT_CONFIG_KEY_0:'http.followRedirects',GIT_CONFIG_VALUE_0:'false',
    GIT_CONFIG_KEY_1:'credential.helper',GIT_CONFIG_VALUE_1:'',
    GIT_CONFIG_KEY_2:'core.hooksPath',GIT_CONFIG_VALUE_2:'/dev/null',
    GIT_CONFIG_KEY_3:'http.proxy',GIT_CONFIG_VALUE_3:''};
}
