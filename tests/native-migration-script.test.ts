import { expect, test } from 'bun:test';

// Exercise the executable migration guard and state semantics without a live Docker mutation.
test('migration refuses unrelated services and non-private/native credential origins', () => {
  const result = Bun.spawnSync(['python3', '-c', `
import importlib.util, tempfile, pathlib, unittest.mock, sys
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('migration','scripts/forgejo-native-migration.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
assert not m.stopped([{'replicas':0,'active_tasks':[{'CurrentState':'Running'}]}], 'swarm')
assert m.stopped([{'replicas':0,'active_tasks':[]}], 'swarm')
with unittest.mock.patch.object(m,'docker',side_effect=['[{"Spec":{"Mode":{"Replicated":{"Replicas":0}}}}]','{"CurrentState":"Orphaned 1 minute ago"}']):
 assert not m.stopped(m.writer_state('swarm',['git-org-reconciler']),'swarm')
assert not m.stopped([{'running':False,'restart':'unless-stopped'}], 'compose')
assert m.stopped([{'running':False,'restart':'no'}], 'compose')
for origin in ['http://forgejo.example','https://evil@forgejo.example','https://forgejo.example/api','https://forgejo.example?x=1']:
 try:m.native_api(origin,'/missing');assert False
 except RuntimeError:pass
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d)/'token';p.write_text('management-secret');p.chmod(0o644)
 try:m.native_api('https://forgejo.example',p);assert False
 except RuntimeError:pass
 p.chmod(0o600)
 try:m.native_api('https://forgejo.example',pathlib.Path(d));assert False
 except RuntimeError:pass
 req=m.native_api('https://forgejo.example',p)
 class Reply:
  def __enter__(self):return self
  def __exit__(self,*args):pass
  def read(self):return b'{}'
 with unittest.mock.patch('urllib.request.OpenerDirector.open',return_value=Reply()) as request:
  req('/users/lara')
  actual=request.call_args.args[0]
  assert actual.full_url=='https://forgejo.example/api/v1/users/lara'
  assert actual.get_header('Authorization')=='token management-secret'
 proof=pathlib.Path(d)/'proof.json';m.write_json(proof,{'stopped':True})
 assert proof.stat().st_mode&0o777==0o600
 try:m.write_json(proof,{});assert False
 except FileExistsError:pass
 with unittest.mock.patch('sys.argv',['migration','writers','--writer','postgres','--writer','git-org-reconciler','--writer','git-identity-reconciler','--output',str(pathlib.Path(d)/'new')]),unittest.mock.patch.object(m,'docker') as dock:
  try:m.main();assert False
  except RuntimeError:pass
  dock.assert_not_called()
print('migration guards passed')
`]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('migration guards passed');
});

const behaviorHarness = `
import importlib.util, tempfile, pathlib, unittest.mock, sys, json, contextlib, io
from urllib.parse import urlsplit,parse_qs
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('migration','scripts/forgejo-native-migration.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Native:
 def __init__(self, scenario):
  self.scenario=scenario;self.calls=[];self.permissions={repo:'none' for repo in m.REPOS};self.puts=[]
 def __call__(self,path,method='GET',body=None):
  self.calls.append((path,method,body))
  if method=='PUT':
   assert path in ['/repos/'+repo+'/collaborators/lara' for repo in m.REPOS]
   assert body=={'permission':'write'}
   self.puts.append((path,method,body))
   if self.scenario=='partial-failure' and len(self.puts)==2:raise RuntimeError('Simulated native PUT failure')
   if self.scenario!='write-denied':self.permissions[path.removeprefix('/repos/').removesuffix('/collaborators/lara')]='write'
   return None
  assert method=='GET'
  if path=='/users/lara':return {'id':9 if self.scenario=='wrong-id' else 8,'login':'lara','is_admin':self.scenario=='admin'}
  parsed=urlsplit(path);page=int(parse_qs(parsed.query).get('page',['1'])[0]);base=parsed.path
  if base=='/orgs/other-stuff/teams':rows=[{'id':11},{'id':12}]
  elif base.startswith('/teams/') and base.endswith('/members'):rows=[{'id':21},{'id':22}]
  else:
   rows=None
   for repo in m.REPOS:
    root='/repos/'+repo
    if base==root:return {'full_name':repo,'private':True}
    if base==root+'/collaborators/lara/permission':return {'permission':self.permissions[repo]}
    if base==root+'/collaborators':rows=[{'id':8,'login':'lara'},{'id':5,'login':'pete'}]
    if base==root+'/teams':rows=[{'id':11},{'id':12}]
    if base==root+'/branch_protections':rows=[{'branch_name':'main','enable_push':False},{'branch_name':'deployed','enable_push':False}]
   assert rows is not None, path
  # Deliberately emulate a server that clamps requested limit=50 to one row.
  if self.scenario=='protection-drift' and self.puts and base.endswith('/branch_protections'):rows=[{'branch_name':'main','enable_push':True}]
  if base.startswith('/repos/') and (base.endswith('/teams') or base.endswith('/branch_protections')):
   assert not parsed.query,'Stock Forgejo 16 endpoint does not paginate: '+path
   return rows
  return rows[page-1:page]

def exercise(scenario,apply=True,expected_error=None):
 with tempfile.TemporaryDirectory() as directory:
  output=pathlib.Path(directory)/'evidence.json';native=Native(scenario);docker_calls=[]
  def fake_docker(*args):
   docker_calls.append(args)
   assert args[:2] in [('service','inspect'),('service','ps')],args
   if args[:2]==('service','inspect'):
    return json.dumps([{'Spec':{'Mode':{'Replicated':{'Replicas':1 if scenario=='running-writer' else 0}}}}])
   return ''
  argv=['migration','restore-lara','--mode','swarm','--writer','git-org-reconciler','--writer','git-identity-reconciler','--forgejo-origin','https://forgejo.example','--management-token-file','/unused-private-management-file','--output',str(output)]
  if apply:argv+=['--apply']
  with unittest.mock.patch('sys.argv',argv),unittest.mock.patch.object(m,'native_api',return_value=native),unittest.mock.patch.object(m,'docker',side_effect=fake_docker),contextlib.redirect_stdout(io.StringIO()):
   try:
    m.main()
    assert expected_error is None,'Expected failure: '+str(expected_error)
   except RuntimeError as error:
    assert expected_error and expected_error in str(error),(expected_error,str(error))
  before=pathlib.Path(str(output)+'.before.json')
  if expected_error:
   assert not output.exists(),'Failed operation must not produce success evidence'
   if scenario in ('wrong-id','admin','running-writer'):
    assert not native.puts and not before.exists()
   else:
    assert before.exists(),'Before snapshot must survive mutation/verification failure'
    saved=json.loads(before.read_text())
    assert all(row['lara_permission']['permission']=='none' for row in saved['native']['repositories'].values())
  elif not apply:
   assert native.puts==[] and not before.exists()
   assert json.loads(output.read_text())['user']['id']==8
  else:
   assert native.puts==[('/repos/'+repo+'/collaborators/lara','PUT',{'permission':'write'}) for repo in m.REPOS]
   assert before.exists()
   saved=json.loads(output.read_text())
   for repo in m.REPOS:
    assert saved['before']['repositories'][repo]['lara_permission']['permission']=='none'
    assert saved['after']['repositories'][repo]['lara_permission']['permission']=='write'
    assert saved['before']['repositories'][repo]['branch_protections']==saved['after']['repositories'][repo]['branch_protections']
   assert all(row['replicas']==0 and row['active_tasks']==[] for row in saved['writer_proof'])
   assert output.stat().st_mode&0o777==0o600
   assert before.stat().st_mode&0o777==0o600
  if scenario!='running-writer':
   # Only pageable routes use empty-page termination despite provider clamp=1.
   for base in ['/orgs/other-stuff/teams','/teams/11/members','/teams/12/members']+['/repos/'+repo+suffix for repo in m.REPOS for suffix in ['/collaborators']]:
    assert (base+'?limit=50&page=3','GET',None) in native.calls,base
   expected_snapshots=2 if apply and scenario in ('success','write-denied','protection-drift') else 1
   for base in ['/repos/'+repo+suffix for repo in m.REPOS for suffix in ['/teams','/branch_protections']]:
    assert native.calls.count((base,'GET',None))==expected_snapshots,(base,native.calls)
    assert not any(path.startswith(base+'?') for path,method,body in native.calls)
   if not expected_error:
    saved=json.loads(output.read_text());snapshot=saved['after'] if apply else saved
    assert len(snapshot['teams'])==2
    assert all(len(team['members'])==2 for team in snapshot['teams'])
    assert all(len(row['collaborators'])==2 and len(row['teams'])==2 and len(row['branch_protections'])==2 for row in snapshot['repositories'].values())
  return native
`;

for (const scenario of [
  { name: 'preview makes no mutations and paginates clamped native lists', code: "exercise('preview',apply=False)" },
  { name: 'applies exactly two native Write grants with before/after proof', code: "exercise('success')" },
  { name: 'refuses a running permission writer before any native mutation', code: "exercise('running-writer',expected_error='Writers are not stopped')" },
  { name: 'refuses the wrong Lara account ID', code: "exercise('wrong-id',expected_error='identity mismatch')" },
  { name: 'refuses unexpected Lara admin privilege', code: "exercise('admin',expected_error='admin privilege')" },
  { name: 'preserves before evidence when the second native PUT fails', code: "exercise('partial-failure',expected_error='Simulated native PUT failure')" },
  { name: 'requires effective native Write after restoration', code: "exercise('write-denied',expected_error='effective Write verification failed')" },
  { name: 'detects branch protection changes and preserves before evidence', code: "exercise('protection-drift',expected_error='Branch protection changed')" },
]) {
  test(`Lara migration ${scenario.name}`, () => {
    const result = Bun.spawnSync(['python3', '-c', behaviorHarness + '\n' + scenario.code]);
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  });
}
