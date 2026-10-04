#!/usr/bin/env python3
"""Own one fixed Node health/acceptance sequence, with no Flow authority."""
import ctypes
import hashlib
import json
import os
import pathlib
import select
import selectors
import signal
import subprocess
import sys
import time

root = pathlib.Path(sys.argv[1])
os.umask(0o077)


def encoded(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def identity(pid):
    text = pathlib.Path('/proc/%s/stat' % pid).read_text()
    fields = text[text.rindex(')') + 2:].split()
    return {'pid': pid, 'start': fields[19],
            'boot': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()}


def parent_pid(pid):
    text = pathlib.Path('/proc/%s/stat' % pid).read_text()
    return int(text[text.rindex(')') + 2:].split()[1])


def owned_handles(parent):
    result = []
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        handle = None
        try:
            expected = identity(int(entry.name))
            if parent_pid(expected['pid']) != parent['pid']:
                continue
            handle = os.pidfd_open(expected['pid'], 0)
            if identity(expected['pid']) != expected or parent_pid(expected['pid']) != parent['pid'] or identity(parent['pid']) != parent:
                continue
            result.extend(owned_handles(expected))
            result.append((handle, expected))
            handle = None
        except OSError:
            pass
        finally:
            if handle is not None:
                os.close(handle)
    return result


def retire():
    escalation = time.monotonic() + 0.5
    while True:
        for handle, expected in owned_handles(owner):
            try:
                if identity(expected['pid']) == expected:
                    signal.pidfd_send_signal(handle, signal.SIGKILL if time.monotonic() >= escalation else signal.SIGTERM)
            except OSError:
                pass
            finally:
                os.close(handle)
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            return
        time.sleep(0.01)


def run_node(arguments, label):
    # Arguments are constructed here, never accepted as a command descriptor.
    # No host home/auth roots, writable repository or host network enter this
    # namespace. The sole persistent writable mount belongs to this effect.
    scratch = root / 'scratch'
    scratch.mkdir(exist_ok=True, mode=0o700)
    args = [reservation['sandbox'], '--unshare-all', '--cap-drop', 'ALL', '--new-session',
            '--die-with-parent', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib',
            '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev',
            '--tmpfs', '/tmp', '--dir', '/runner', '--ro-bind', config['executable']['path'], '/runner/node',
            '--ro-bind', reservation['reporter'], '/runner/reporter.mjs',
            '--ro-bind', reservation['workspace'], '/workspace', '--bind', str(scratch), '/scratch',
            '--chdir', '/workspace', '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin',
            '--setenv', 'FLOW_CHECK_SCRATCH', '/scratch', '--', '/runner/node', *arguments]
    child = subprocess.Popen(args, env={'PATH': '/usr/bin:/bin'},
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    deadline = time.monotonic() + config['limits']['timeout_ms'] / 1000
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    pipes = selectors.DefaultSelector()
    for name in output:
        stream = getattr(child, name)
        os.set_blocking(stream.fileno(), False)
        pipes.register(stream, selectors.EVENT_READ, name)
    failed = None
    while pipes.get_map() or child.poll() is None:
        if time.monotonic() >= deadline:
            failed = 'timeout'
            break
        for key, _ in pipes.select(0.01):
            chunk = os.read(key.fileobj.fileno(), 8192)
            if chunk:
                output[key.data].extend(chunk)
                if sum(map(len, output.values())) > config['limits']['max_output_bytes']:
                    failed = 'output_limit'
                    break
            else:
                pipes.unregister(key.fileobj)
        if failed:
            break
    # Parent exit or group absence is insufficient, including on timeout.
    # Every descendant is reparented to this worker. Only ECHILD permits proof.
    retire()
    pipes.close()
    for stream in (child.stdout, child.stderr):
        stream.close()
    code = child.returncode
    if code is None:
        code = child.poll()
    for name, data in output.items():
        with (root / (label + '.' + name)).open('wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    return code, bytes(output['stdout']), bytes(output['stderr']), failed


reservation = json.loads((root / 'reservation.json').read_text())
config = reservation['config']
owner = identity(os.getpid())
terminal = {'reservation_digest': reservation['reservation_digest'], 'version': None,
            'checks': [], 'failure': None, 'retired': False, 'proof': None, 'owner': owner}
try:
    if sys.platform != 'linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('containment_unavailable')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('containment_unavailable')
    flag = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(flag), 0, 0, 0) != 0 or flag.value != 1:
        raise RuntimeError('containment_unavailable')
    with (root / 'worker.json').open('wb') as stream:
        stream.write(encoded({'owner': owner, 'reservation_digest': reservation['reservation_digest']}) + b'\n')
        stream.flush()
        os.fsync(stream.fileno())
    directory = os.open(root, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    for path, expected in [(sys.executable, reservation['python_sha256']), (__file__, reservation['worker_sha256']),
                           (reservation['reporter'], reservation['reporter_sha256']),
                           (config['executable']['path'], config['executable']['sha256']),
                           (reservation['sandbox'], reservation['sandbox_sha256'])]:
        if sha(pathlib.Path(path).read_bytes()) != expected:
            raise RuntimeError('runner_identity_changed')
    version = subprocess.run([reservation['sandbox'], '--version'], env={'PATH': '/usr/bin:/bin'},
                             capture_output=True, timeout=2, check=True)
    if version.stdout.decode().strip() != reservation['sandbox_version'] or version.stderr:
        raise RuntimeError('sandbox_version_changed')
    code, stdout, stderr, failed = run_node(['--version'], 'version')
    if failed or code != 0 or stderr:
        raise RuntimeError(failed or 'version_unavailable')
    terminal['version'] = stdout.decode().strip()
    if terminal['version'] != config['executable']['version']:
        raise RuntimeError('version_changed')
    for name in ('health', 'acceptance'):
        code, stdout, stderr, failed = run_node(['--test', '--test-concurrency=1',
                                               '--test-reporter=/runner/reporter.mjs', config[name]['path']], name)
        if failed or stderr or not stdout.endswith(b'\n'):
            raise RuntimeError(failed or 'malformed_output')
        events = [json.loads(line) for line in stdout.decode().splitlines()]
        terminal['checks'].append({'phase': name, 'exit_code': code, 'events': events,
                                   'stdout_sha256': sha(stdout), 'stderr_sha256': sha(stderr)})
        if name == 'health' and code != 0:
            raise RuntimeError('health_failed')
except Exception as error:
    terminal['failure'] = str(error) if isinstance(error, RuntimeError) else 'malformed_output'
finally:
    retire()
    terminal['retired'] = True
    terminal['proof'] = 'linux_subreaper_echild'
    terminal['self_digest'] = sha(encoded(terminal))
    with (root / 'terminal.json.new').open('wb') as stream:
        stream.write(encoded(terminal) + b'\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(root / 'terminal.json.new', root / 'terminal.json')
    directory = os.open(root, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
