#!/usr/bin/python3
"""Bounded Linux-only synthetic Flow observation diagnostic; never use retained authority."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--node', required=True, help='Absolute already-installed Node22.23.1 executable; never installed or version-probed')
parser.add_argument('--output', required=True, help='New private directory for synthetic authorities and raw measurements')
parser.add_argument('--source', default=str(Path(__file__).resolve().parents[3]), help='Clean Flow checkout with its existing dependencies')
parser.add_argument('--socket-only', action='store_true', help='Only finite slow-consumer canaries, without CPU workload')
args = parser.parse_args()
if sys.platform != 'linux':
    parser.error('This diagnostic uses Linux /proc counters; Mac measurements are separate work.')
node = Path(args.node)
if not node.is_absolute() or not node.is_file() or not os.access(node, os.X_OK):
    parser.error('--node must name an existing absolute executable')
base = Path(__file__).resolve().parent
root = Path(args.source).resolve()
plan = json.loads((base / 'linux-plan.v1.json').read_text())
out = Path(args.output).resolve()
reserve = plan['bounds']['disk_reserve_bytes']
if min(shutil.disk_usage(root).free, shutil.disk_usage(out.parent).free) < reserve:
    parser.error('Source and output filesystems each require the 2GiB free-disk reserve')
out.mkdir(mode=0o700)
(out / 'measurement-plan.json').write_text(json.dumps(plan, indent=2) + '\n')
env = {key: value for key, value in os.environ.items()
       if not key.startswith(('FLOW_', 'DOTFILES_', 'CODEX_', 'CLAUDE_', 'OPENAI_', 'ANTHROPIC_', 'GIT_', 'MISE_'))
       and not key.endswith(('_TOKEN', '_API_KEY', '_SECRET', '_PASSWORD'))
       and key not in ['NODE_OPTIONS', 'NODE_PATH', 'NODE_TEST_CONTEXT', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID']}
for name in ['home', 'state', 'config', 'cache']:
    (out / name).mkdir(mode=0o700)
env.update(HOME=str(out / 'home'), XDG_STATE_HOME=str(out / 'state'),
           XDG_CONFIG_HOME=str(out / 'config'), XDG_CACHE_HOME=str(out / 'cache'),
           PATH='/usr/bin:/bin', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_OPTIONAL_LOCKS='0')
def git(*arguments):
    return subprocess.check_output(['/usr/bin/git', '-c', 'core.fsmonitor=false', '-C', str(root), *arguments], env=env, timeout=10).decode().strip()
if git('status', '--porcelain'):
    parser.error('--source must be clean; commit reviewed changes before measuring')
commit = git('rev-parse', 'HEAD')
command = [str(node), str(base / 'observation.mjs'), str(root), str(out)]
if args.socket_only:
    command.append('--socket-only')
start = time.monotonic()
with (out / 'stdout.log').open('wb') as stdout, (out / 'stderr.log').open('wb') as stderr:
    child = subprocess.Popen(command, cwd=root, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
    print(json.dumps({'output': str(out), 'pid': child.pid, 'command': command}), flush=True)
    reason = None
    while child.poll() is None:
        if time.monotonic() - start > plan['bounds']['wall_seconds']:
            reason = 'deadline'
        if min(shutil.disk_usage(root).free, shutil.disk_usage(out).free) < reserve:
            reason = 'disk_reserve'
        if sum(path.stat().st_size for path in out.rglob('*') if path.is_file()) > plan['bounds']['fixture_bytes']:
            reason = 'fixture_bytes'
        if reason:
            os.killpg(child.pid, signal.SIGTERM)
            break
        time.sleep(0.2)
    try:
        code = child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        code = child.wait()
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()
receipt = {'source_worktree': str(root), 'source_commit': commit,
           'source_head_after': git('rev-parse', 'HEAD'), 'source_clean_after': not git('status', '--porcelain'),
           'pid': child.pid, 'actual_exit': code, 'stop_reason': reason,
           'elapsed_seconds': time.monotonic() - start, 'command': command,
           'plan_sha256': sha(out / 'measurement-plan.json'), 'stdout_sha256': sha(out / 'stdout.log'),
           'stderr_sha256': sha(out / 'stderr.log'),
           'report_sha256': sha(out / 'report.json') if (out / 'report.json').exists() else None}
(out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt), flush=True)
raise SystemExit(code if code >= 0 else 128 - code)
