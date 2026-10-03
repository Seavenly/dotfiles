import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectDelegatedAgentPort } from "../src/direct-delegated-agent-port.mjs";
import { digest } from "../src/canonical.mjs";
import { digestDelegateInputBytes } from "../src/delegate-input-envelope.mjs";

export async function directTaskFixture(t, mode = "complete") {
  const scratch = await mkdtemp(join(tmpdir(), "flow-direct-owned-"));
  const executable = join(scratch, "codex-fixture");
  await writeFile(executable, `#!/usr/bin/python3
import sys,json,pathlib,os,time,signal
root=pathlib.Path(${JSON.stringify(scratch)})
mode=${JSON.stringify(mode)}
if sys.argv[1:]==['--version']:
 print('codex-cli 0.160.0');sys.exit(0)
with (root/'launches').open('a') as stream:stream.write('once\\n')
(root/'provider-pid').write_text(str(os.getpid()))
(root/'input').write_bytes(sys.stdin.buffer.read())
(root/'argv.json').write_text(json.dumps(sys.argv[1:]))
if mode=='failure_without_result':sys.exit(12)
if mode=='wait':
 while not (root/'release').exists():time.sleep(.02)
if mode in ['descendant','stubborn_descendant']:
 if os.fork()==0:
  os.setsid()
  if os.fork()!=0:os._exit(0)
  if mode=='stubborn_descendant':signal.signal(signal.SIGTERM,signal.SIG_IGN)
  (root/'descendant-pid').write_text(str(os.getpid()))
  while not (root/'release').exists():time.sleep(.02)
  os._exit(0)
output=json.dumps({'schema':'fixture.result/v1','answer':42},separators=(',',':'))
if mode!='complete_without_result':pathlib.Path(sys.argv[sys.argv.index('--output-last-message')+1]).write_text(output)
events=[{'type':'thread.started','thread_id':'thread-fixture'},{'type':'turn.started'}, {'type':'item.completed','item':{'id':'commentary','type':'agent_message','text':'Checking the workspace.'}}, {'type':'item.completed','item':{'id':'final','type':'agent_message','text':output}},{'type':'turn.completed','usage':{}}]
if mode=='nonterminal':events=events[:-1]
if mode=='malformed':print('not json');sys.exit(0)
if mode=='duplicate_final':events.insert(-1,{'type':'item.completed','item':{'id':'second','type':'agent_message','text':output}})
for event in events:print(json.dumps(event),flush=True)
if mode=='failure':sys.exit(12)
`);
  await chmod(executable, 0o700);
  const env = { HOME: scratch, PATH: process.env.PATH };
  const taskDirectory = join(scratch, "tasks");
  const options = { env, executables: { codex: executable }, taskDirectory,
    resolveWorkspace: () => ({ canonical_path: scratch }) };
  const port = createDirectDelegatedAgentPort(options);
  const { description } = await port.describe({ schema: "flow.delegated-agent-description-request/v1",
    launch: { harness: "codex", model: "fixture-model", effort: "high", capability: "read-only" }, caller_metadata: {} });
  const prompt = 'exact stdin $() `literal`\nλ\n';
  const request = { schema: "flow.delegated-agent-dispatch-request/v1", agent_id: "agent:fixture",
    caller_key: "attempt:fixture", input_key: "attempt:fixture:input:1", prompt,
    payload_sha256: digestDelegateInputBytes(prompt), description,
    task_binding: { run_id: "run:fixture", card_id: "card:fixture", attempt_id: "attempt:fixture", effect_id: "effect:fixture",
      workspace_claim: { subject_id: "workspace:fixture", generation: 1, mutation_epoch: 0, fingerprint: digest({ initial: true }), access: "read_only" },
      output_contract: { schemas: ["fixture.result/v1"], schema: { type: "object", additionalProperties: false, required: ["schema", "answer"], properties: { schema: { const: "fixture.result/v1" }, answer: { type: "integer" } } } } } };
  t.after(() => rm(scratch, { recursive: true, force: true }));
  return { scratch, port, request, options, freshPort: () => createDirectDelegatedAgentPort(options),
    release: () => writeFile(join(scratch, "release"), "release") };
}

// Execute the actual worker in an outer exception boundary. Catching its exit
// retains the same subreaper until the RED baseline's owned children are reaped.
export async function directTaskFailureFixture(t, fault, failPersistence, mode = "stubborn_descendant") {
  const fixture = await directTaskFixture(t, mode);
  const wrapper = join(fixture.scratch, "failure-supervisor.py");
  await writeFile(wrapper, `import ctypes,errno,json,os,pathlib,signal,subprocess,sys,time
worker_path=sys.argv[1]
root=pathlib.Path(sys.argv[2])
fault=${JSON.stringify(fault)}
fail_persistence=${failPersistence ? "True" : "False"}
native_root=pathlib.Path(${JSON.stringify(fixture.scratch)})
original_popen=subprocess.Popen
events=[]
original_waitpid=os.waitpid
def waitpid(*args):
 try:return original_waitpid(*args)
 except ChildProcessError:
  events.append({'event':'echild'})
  raise
os.waitpid=waitpid
original_fsync=os.fsync
def fsync(fd):
 path=pathlib.Path(os.readlink('/proc/self/fd/%s'%fd))
 if path.parent==root and path.name in ['stdout.bin','stderr.bin','last-message.json']:
  events.append({'event':'sync','name':path.name})
  if fault=='output_sync_'+path.name:raise OSError(errno.ENOSPC,'fixture_output_sync_failed')
 return original_fsync(fd)
os.fsync=fsync
original_read_bytes=pathlib.Path.read_bytes
def read_bytes(path):
 if path.parent==root and path.name in ['stdout.bin','stderr.bin','last-message.json']:
  events.append({'event':'read','name':path.name})
 return original_read_bytes(path)
pathlib.Path.read_bytes=read_bytes
def popen(*args,**kwargs):
 child=original_popen(*args,**kwargs)
 if ${JSON.stringify(mode)}=='stubborn_descendant':
  deadline=time.monotonic()+3
  while not (native_root/'descendant-pid').exists():
   if time.monotonic()>deadline:raise RuntimeError('fixture_descendant_missing')
   time.sleep(.01)
 if fault=='cancellation_conflict':
  (root/'cancel.json').write_text(json.dumps({'schema':'flow.task-cancellation/v1','descriptor_digest':'foreign'}))
 if fault=='cancellation_without_result':
  deadline=time.monotonic()+3
  while not (native_root/'provider-pid').exists():
   if time.monotonic()>deadline:raise RuntimeError('fixture_provider_missing')
   time.sleep(.01)
  descriptor=json.loads((root/'descriptor.json').read_text())
  (root/'cancel.json').write_text(json.dumps({'schema':'flow.task-cancellation/v1','descriptor_digest':descriptor['descriptor_digest']}))
 return child
subprocess.Popen=popen
original_dump=json.dump
def dump(value,*args,**kwargs):
 if value.get('schema')=='flow.task-terminal-receipt/v1':events.append({'event':'receipt'})
 if (fault=='running_record' and value.get('schema')=='flow.task-process/v1' and value.get('stage')=='running') or (fail_persistence and value.get('schema')=='flow.task-failure/v1'):
  raise OSError(errno.ENOSPC,'fixture_storage_full')
 return original_dump(value,*args,**kwargs)
json.dump=dump
original_signal=signal.pidfd_send_signal
signal_attempts=[]
def send_signal(handle,kind,*args):
 signal_attempts.append(kind)
 if ${JSON.stringify(mode)}=='stubborn_descendant' and len(signal_attempts)==1:raise OSError(errno.EAGAIN,'fixture_signal_uncertain')
 return original_signal(handle,kind,*args)
signal.pidfd_send_signal=send_signal
sys.argv=[worker_path,str(root)]
namespace={'__name__':'__main__','__file__':worker_path}
try:
 exec(compile(pathlib.Path(worker_path).read_text(),worker_path,'exec'),namespace)
except BaseException:
 pass
production_kills=signal_attempts.count(signal.SIGKILL)
signal.pidfd_send_signal=original_signal
try:
 os.waitpid(-1,os.WNOHANG)
 retired_before_wrapper=False
except ChildProcessError:
 retired_before_wrapper=True
boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
def snapshot(pid):
 text=pathlib.Path('/proc/%s/stat'%pid).read_text()
 fields=text[text.rindex(')')+2:].split()
 return (pid,fields[19],int(fields[2]),boot),int(fields[1])
def kill_owned(parent,parent_identity):
 if snapshot(parent)[0]!=parent_identity:return
 # Kernel-maintained child lists bound traversal to this fixture's own tree.
 children=pathlib.Path('/proc/%s/task/%s/children'%(parent,parent)).read_text().split()
 for text in children:
  handle=None
  try:
   pid=int(text);expected,ppid=snapshot(pid)
   if ppid!=parent:continue
   handle=os.pidfd_open(pid,0)
   if snapshot(pid)!=(expected,parent) or snapshot(parent)[0]!=parent_identity:continue
   kill_owned(pid,expected)
   if snapshot(pid)==(expected,parent):signal.pidfd_send_signal(handle,signal.SIGKILL)
  except (FileNotFoundError,ProcessLookupError):
   pass
  finally:
   if handle is not None:os.close(handle)
deadline=time.monotonic()+5
owner=snapshot(os.getpid())[0]
while True:
 kill_owned(os.getpid(),owner)
 try:
  while os.waitpid(-1,os.WNOHANG)[0]:pass
 except ChildProcessError:
  break
 if time.monotonic()>deadline:raise RuntimeError('fixture_retirement_timeout')
 time.sleep(.01)
(native_root/'failure-report.json').write_text(json.dumps({'retired_before_wrapper':retired_before_wrapper,'wrapper_echild':True,'production_kills':production_kills,'events':events}))
`);
  return { ...fixture, wrapper };
}
