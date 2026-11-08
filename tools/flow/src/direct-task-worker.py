#!/usr/bin/env python3
"""One durable task owner. It never admits work or chooses a retry."""
import ctypes
import hashlib
import json
import os
import pathlib
import signal
import select
import subprocess
import sys
import time

root = pathlib.Path(sys.argv[1])
os.umask(0o077)
child = None

def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()

def atomic(name, value):
    temporary = root / (name + '.new')
    with temporary.open('w') as stream:
        json.dump(value, stream, sort_keys=True, separators=(',', ':'))
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, root / name)
    directory = os.open(root, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)

def identity(pid):
    return snapshot(pid)[0]

def snapshot(pid):
    # /proc fields after comm are state, ppid, pgrp, ... starttime (field 22).
    stat = pathlib.Path('/proc/%s/stat' % pid).read_text()
    fields = stat[stat.rindex(')') + 2:].split()
    return ({'pid': pid, 'start': fields[19], 'group': int(fields[2]),
             'boot': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()}, int(fields[1]))

def handle_alive(handle):
    poll = select.poll()
    poll.register(handle, select.POLLIN)
    return not poll.poll(0)

def owned_handles(parent, parent_handle=None):
    # Snapshot ancestry before opening a handle, then validate both identities.
    # A pidfd always targets that process instance, even if its PID is reused.
    result = []
    if (parent_handle is not None and not handle_alive(parent_handle)) or identity(parent['pid']) != parent:
        return result
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        handle = None
        try:
            expected, ppid = snapshot(int(entry.name))
            if ppid != parent['pid']:
                continue
            handle = os.pidfd_open(expected['pid'], 0)
            current, current_parent = snapshot(expected['pid'])
            if current != expected or current_parent != parent['pid'] or identity(parent['pid']) != parent or (parent_handle is not None and not handle_alive(parent_handle)):
                os.close(handle)
                handle = None
                continue
            result.extend(owned_handles(expected, handle))
            result.append((handle, expected))
            handle = None
        except OSError:
            pass
        finally:
            if handle is not None:
                os.close(handle)
    return result

def retire_failed_tree(worker):
    kill_after = time.monotonic() + 1
    while True:
        try:
            handles = owned_handles(worker)
        except OSError:
            handles = []
        for handle, expected in handles:
            try:
                if identity(expected['pid']) == expected:
                    signal.pidfd_send_signal(handle, signal.SIGKILL if time.monotonic() >= kill_after else signal.SIGTERM)
            except OSError:
                pass
            finally:
                os.close(handle)
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            return
        except InterruptedError:
            pass
        # A signal or identity failure never releases the sole subreaper.
        # Only positive ECHILD permits exit, even after escalation.
        time.sleep(0.02)

try:
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('pidfd_unavailable')
    descriptor = json.loads((root / 'descriptor.json').read_text())
    supervision = descriptor['supervision']
    if sha(pathlib.Path(sys.executable).read_bytes()) != supervision['executable_sha256'] or sha(pathlib.Path(__file__).read_bytes()) != supervision['worker_sha256']:
        raise RuntimeError('supervision_identity_changed')
    worker = identity(os.getpid())
    # Linux reparenting closes the double-fork/setsid escape from group proof.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('subreaper_unavailable')
    flag = ctypes.c_int()
    if libc.prctl(37, ctypes.byref(flag), 0, 0, 0) != 0 or flag.value != 1:
        raise RuntimeError('subreaper_unavailable')
    atomic('worker.json', {'schema': 'flow.task-process/v1', 'identity': worker,
                          'descriptor_digest': descriptor['descriptor_digest'], 'stage': 'before_spawn', 'containment': 'linux_subreaper'})
    invocation = descriptor['invocation']
    input_bytes = (root / 'input.bin').read_bytes()
    if (root / 'output-schema.json').read_text() != descriptor['output_schema_bytes']:
        raise RuntimeError('output_schema_digest_conflict')
    if 'native_output_schema_bytes' in descriptor:
        native_schema = (root / 'native-output-schema.json').read_bytes()
        if native_schema.decode('utf-8') != descriptor['native_output_schema_bytes'] or sha(native_schema) != descriptor['native_output_schema_sha256']:
            raise RuntimeError('native_output_schema_digest_conflict')
    if sha(input_bytes) != descriptor['input_sha256']:
        raise RuntimeError('input_digest_conflict')
    if sha(pathlib.Path(invocation['executable']).read_bytes()) != descriptor['description']['backend']['executable']['sha256']:
        raise RuntimeError('executable_identity_changed')
    with (root / 'stdout.bin').open('wb', buffering=0) as stdout, (root / 'stderr.bin').open('wb', buffering=0) as stderr, (root / 'input.bin').open('rb') as stdin:
        child = subprocess.Popen([invocation['executable'], *invocation['args']], cwd=invocation['cwd'],
                                 env=descriptor['environment'], stdin=stdin, stdout=stdout, stderr=stderr,
                                 start_new_session=True, close_fds=True)
        child_identity = identity(child.pid)
        atomic('worker.json', {'schema': 'flow.task-process/v1', 'identity': worker, 'child': child_identity,
                              'descriptor_digest': descriptor['descriptor_digest'], 'stage': 'running', 'containment': 'linux_subreaper'})
        native_status = None
        cancelled = False
        cancel_at = None
        while True:
            if (root / 'cancel.json').exists():
                cancellation = json.loads((root / 'cancel.json').read_text())
                if cancellation.get('descriptor_digest') != descriptor['descriptor_digest']:
                    raise RuntimeError('cancellation_identity_conflict')
                cancelled = True
                if cancel_at is None:
                    cancel_at = time.monotonic()
                handles = owned_handles(worker)
                for handle, expected in handles:
                    try:
                        if identity(expected['pid']) == expected:
                            signal.pidfd_send_signal(handle, signal.SIGKILL if time.monotonic() - cancel_at > 1 else signal.SIGTERM)
                    except (FileNotFoundError, ProcessLookupError):
                        pass
                    finally:
                        os.close(handle)
            while True:
                try:
                    pid, status = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    # ECHILD proves every descendant has exited and been reaped.
                    if native_status is None:
                        raise RuntimeError('native_status_missing')
                    # The durable receipt must not outlive the output it binds.
                    for stream in (stdout, stderr):
                        stream.flush()
                        os.fsync(stream.fileno())
                    last_message = root / 'last-message.json'
                    requires_result = descriptor['description']['backend']['harness'] == 'codex' and native_status == 0 and not cancelled
                    if requires_result or last_message.exists():
                        with last_message.open('rb') as result:
                            os.fsync(result.fileno())
                    atomic('receipt.json', {'schema': 'flow.task-terminal-receipt/v1',
                        'descriptor_digest': descriptor['descriptor_digest'],
                        'input_sha256': descriptor['input_sha256'],
                        'stdout_sha256': sha((root / 'stdout.bin').read_bytes()),
                        'stderr_sha256': sha((root / 'stderr.bin').read_bytes()),
                        'exit_code': native_status, 'worker_identity': worker,
                        'child_identity': child_identity, 'tree_retired': True, 'cancelled': cancelled})
                    sys.exit(0)
                if pid == 0:
                    break
                if pid == child.pid:
                    native_status = os.waitstatus_to_exitcode(status)
                    child.returncode = native_status
            time.sleep(0.02)
except SystemExit:
    raise
except Exception as error:
    # Failure is durable uncertainty, never an invented no-spawn receipt.
    try:
        atomic('failure.json', {'schema': 'flow.task-failure/v1', 'reason': str(error) if str(error).replace('_', '').isalnum() else 'worker_failed'})
    except OSError:
        pass
    finally:
        if child is not None:
            retire_failed_tree(worker)
    sys.exit(1)
