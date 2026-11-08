#!/usr/bin/env python3
"""Execute one reserved project suite without Flow authority or ambient config.

Input hashes immediately bracket read-only sandbox execution. This is cooperative
host drift detection, not an atomic snapshot against a hostile same-user writer.
"""
import ctypes
import hashlib
import json
import os
import pathlib
import selectors
import signal
import subprocess
import sys
import time

os.umask(0o077)
root = pathlib.Path(sys.argv[1])


def encoded(value, canonical=False):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False, sort_keys=canonical).encode()


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def digest(value):
    return sha(encoded(value, True))


def identity(pid):
    text = pathlib.Path('/proc/%s/stat' % pid).read_text()
    return {'pid': pid, 'start': text[text.rindex(')') + 2:].split()[19],
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
        except (OSError, ValueError):
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


def durable(name, value):
    target = root / (name + '.new')
    with target.open('xb') as stream:
        stream.write(encoded(value) + b'\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(target, root / name)
    directory = os.open(root, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def input_digest(name):
    path = pathlib.Path(name)
    if str(path.resolve(strict=True)) != name:
        raise RuntimeError('input_drift')
    if path.is_file():
        return sha(path.read_bytes())
    records = []
    count = 0
    total = 0

    def walk(path, relative):
        nonlocal count, total
        count += 1
        if count > 100000:
            raise RuntimeError('input_limit')
        if path.name in {'.ssh', '.aws', '.codex', '.claude', '.config', '.gnupg', '.docker', '.kube', '.azure', '.password-store', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.gitconfig', 'auth.json', 'credentials.json', 'pip.conf', '.vault-token'}:
            raise RuntimeError('private_read_path')
        stat = path.lstat()
        if path.is_symlink():
            target = path.resolve(strict=True)
            if not target.is_relative_to(name):
                raise RuntimeError('symlink_escape')
            records.append({'path': relative, 'symlink': os.readlink(path)})
        elif path.is_dir():
            records.append({'path': relative, 'directory': True})
            for child in sorted(path.iterdir(), key=lambda child: child.name.encode('utf-16-be')):
                walk(child, relative + '/' + child.name if relative else child.name)
        elif path.is_file():
            total += stat.st_size
            if total > 1024 * 1024 * 1024:
                raise RuntimeError('input_limit')
            records.append({'path': relative, 'executable': bool(stat.st_mode & 0o111), 'sha256': sha(path.read_bytes())})
        else:
            raise RuntimeError('invalid_input')
    walk(path, '')
    return digest(records)


def validate_read_path(name):
    path = pathlib.Path(name)
    authority = pathlib.Path(reservation['authority_directory']).resolve(strict=True)
    private_names = {'.ssh', '.aws', '.codex', '.claude', '.config', '.gnupg', '.docker', '.kube', '.azure', '.password-store', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.gitconfig', 'auth.json', 'credentials.json', 'pip.conf', '.vault-token'}
    if path == authority or path.is_relative_to(authority) or authority.is_relative_to(path) or any(part in private_names for part in path.parts) or any(path == pathlib.Path(prefix) or path.is_relative_to(prefix) for prefix in ('/etc', '/proc', '/dev', '/root')):
        raise RuntimeError('private_read_path')


def validate_inputs():
    for spec in [runner['python'], runner['sandbox'], runner['worker'], runner['implementation'], runner['descriptor'], config['executable']]:
        if sha(pathlib.Path(spec['path']).read_bytes()) != spec['sha256']:
            raise RuntimeError('runner_identity_changed')
    executable = pathlib.PurePosixPath(config['executable']['path'])
    matched = [mount for mount in config['read_mounts'] if executable == pathlib.PurePosixPath(mount['target']) or executable.is_relative_to(mount['target'])]
    if len(matched) != 1:
        raise RuntimeError('executable_mount_mismatch')
    mapped = pathlib.Path(matched[0]['source']) / executable.relative_to(matched[0]['target'])
    if str(mapped.resolve(strict=True)) != config['executable']['path'] or sha(mapped.read_bytes()) != config['executable']['sha256']:
        raise RuntimeError('executable_mount_mismatch')
    for mount in config['read_mounts']:
        validate_read_path(mount['source'])
        if input_digest(mount['source']) != mount['sha256']:
            raise RuntimeError('input_drift')
    for item in config['pinned_files']:
        if input_digest(str(pathlib.Path(reservation['workspace']) / item['path'])) != item['sha256']:
            raise RuntimeError('input_drift')
    if input_digest(reservation['workspace']) != reservation['workspace_digest']:
        raise RuntimeError('workspace_drift')
    head = subprocess.run(['/usr/bin/git', '-C', reservation['source_workspace'], 'rev-parse', 'HEAD^{commit}'], env={'PATH': '/usr/bin:/bin', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_OPTIONAL_LOCKS': '0'}, capture_output=True, timeout=5, check=True)
    if head.stdout.decode().strip() != reservation['source_commit']:
        raise RuntimeError('workspace_drift')


def cancelled():
    marker = root / 'cancel.json'
    if not marker.exists():
        return False
    value = json.loads(marker.read_text())
    if value != {'run_id': reservation['intent']['run_id'], 'effect_id': reservation['intent']['effect_id'],
                 'reservation_digest': reservation['reservation_digest']}:
        raise RuntimeError('invalid_cancellation')
    return True


def persist_output(label, output):
    for name, data in output.items():
        with (root / (label + '.' + name)).open('wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())


def run_command(arguments, label):
    validate_inputs()
    if cancelled():
        return None, b'', b'', 'cancelled'
    args = [runner['sandbox']['path'], '--unshare-all', '--cap-drop', 'ALL', '--new-session', '--die-with-parent',
            '--proc', '/proc', '--dev', '/dev', '--size', str(runner['temporary_bytes']), '--tmpfs', '/tmp',
            '--size', str(runner['scratch_bytes']), '--tmpfs', '/scratch']
    for name in ('home', 'tmp', 'npm', 'go-build', 'go-mod', 'go-tmp', 'pycache'):
        args.extend(['--dir', '/scratch/' + name])
    args.extend(['--ro-bind', reservation['workspace'], '/workspace'])
    for mount in config['read_mounts']:
        args.extend(['--ro-bind', mount['source'], mount['target']])
    args.extend(['--remount-ro', '/dev', '--remount-ro', '/',
                 '--chdir', '/workspace' + ('' if config['cwd'] == '.' else '/' + config['cwd']), '--clearenv'])
    environment = dict(config['environment'])
    environment.update({'HOME': '/scratch/home', 'TMPDIR': '/scratch/tmp', 'TMP': '/scratch/tmp', 'TEMP': '/scratch/tmp',
                        'FLOW_CHECK_SCRATCH': '/scratch', 'NPM_CONFIG_CACHE': '/scratch/npm', 'NPM_CONFIG_OFFLINE': 'true',
                        'NPM_CONFIG_USERCONFIG': '/scratch/npm-user-config', 'NPM_CONFIG_GLOBALCONFIG': '/scratch/npm-global-config',
                        'NPM_CONFIG_UPDATE_NOTIFIER': 'false', 'NPM_CONFIG_AUDIT': 'false', 'NPM_CONFIG_FUND': 'false',
                        'GOCACHE': '/scratch/go-build', 'GOMODCACHE': '/scratch/go-mod', 'GOTMPDIR': '/scratch/go-tmp',
                        'GOTOOLCHAIN': 'local', 'GOPROXY': 'off', 'GOSUMDB': 'off', 'CGO_ENABLED': '0',
                        'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONPYCACHEPREFIX': '/scratch/pycache'})
    for name, value in environment.items():
        args.extend(['--setenv', name, value])
    args.extend(['--', config['executable']['path'], *arguments])
    child = subprocess.Popen(args, env={'PATH': '/usr/bin:/bin'}, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    timeout = min(config['limits']['timeout_ms'], runner['version_timeout_ms']) if label == 'version' else config['limits']['timeout_ms']
    deadline = time.monotonic() + timeout / 1000
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    pipes = selectors.DefaultSelector()
    for name in output:
        stream = getattr(child, name)
        os.set_blocking(stream.fileno(), False)
        pipes.register(stream, selectors.EVENT_READ, name)
    outcome = None
    try:
        while pipes.get_map() or child.poll() is None:
            if cancelled():
                outcome = 'cancelled'
                break
            if time.monotonic() >= deadline:
                outcome = 'timeout'
                break
            for key, _ in pipes.select(0.01):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if chunk:
                    room = config['limits']['max_output_bytes'] - sum(map(len, output.values()))
                    output[key.data].extend(chunk[:room])
                    # Bounded supervisor-owned readiness evidence, unavailable
                    # to the command, permits deterministic live cancellation.
                    with (root / (label + '.live.' + key.data)).open('wb') as live:
                        live.write(output[key.data])
                        live.flush()
                    if len(chunk) > room:
                        outcome = 'output_limit'
                        break
                else:
                    pipes.unregister(key.fileobj)
            if outcome:
                break
            if child.poll() is not None:
                retire()
        # Capture the actual immediate child's status before the subreaper reaps
        # detached descendants. Popen.poll reaps only its own child.
        code = child.poll()
        retire()
        validate_inputs()
        return code, bytes(output['stdout']), bytes(output['stderr']), outcome
    finally:
        retire()
        pipes.close()
        child.stdout.close()
        child.stderr.close()
        persist_output(label, output)


reservation = json.loads((root / 'reservation.json').read_text())
binding = reservation['binding']
config = binding['registration']
runner = binding['runner']
owner = identity(os.getpid())
terminal = {'reservation_digest': reservation['reservation_digest'], 'version': None, 'outcome': 'environment_failure',
            'exit_code': None, 'failure': None, 'retired': False, 'proof': None, 'owner': owner}
contained = False
try:
    if sys.platform != 'linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('containment_unavailable')
    libc = ctypes.CDLL(None, use_errno=True)
    flag = ctypes.c_int()
    if libc.prctl(36, 1, 0, 0, 0) != 0 or libc.prctl(37, ctypes.byref(flag), 0, 0, 0) != 0 or flag.value != 1:
        raise RuntimeError('containment_unavailable')
    descriptor = dict(reservation)
    expected = descriptor.pop('reservation_digest')
    bound = dict(binding)
    fingerprint = bound.pop('fingerprint')
    if digest(descriptor) != expected or digest(bound) != fingerprint or digest(reservation['intent']) != reservation['intent_digest']:
        raise RuntimeError('invalid_reservation')
    contained = True
    durable('worker.json', {'owner': owner, 'reservation_digest': expected})
    code, stdout, stderr, outcome = run_command(config['version_argv'], 'version')
    if outcome:
        terminal['outcome'] = outcome
    elif code != 0 or stderr or stdout.decode().strip() != config['version']:
        terminal['failure'] = 'version_changed'
    else:
        terminal['version'] = stdout.decode().strip()
        code, stdout, stderr, outcome = run_command(config['argv'], 'command')
        terminal['exit_code'] = code
        terminal['outcome'] = outcome or ('passed' if code == 0 else 'failed')
except Exception as error:
    terminal['failure'] = str(error) if isinstance(error, RuntimeError) else 'malformed_environment'
    terminal['outcome'] = 'environment_failure'
finally:
    retire()
    for label in ('version', 'command'):
        for name in ('stdout', 'stderr'):
            path = root / (label + '.' + name)
            if not path.exists():
                with path.open('xb') as stream:
                    stream.flush()
                    os.fsync(stream.fileno())
            key = ('' if label == 'command' else 'version_') + name + '_sha256'
            terminal[key] = sha(path.read_bytes())
    lock = root / 'publication.lock'
    lock_deadline = time.monotonic() + 5
    while True:
        try:
            lock.mkdir(mode=0o700)
            break
        except FileExistsError:
            if time.monotonic() >= lock_deadline:
                # No terminal proof is published when exclusion is uncertain.
                sys.exit(2)
            time.sleep(0.01)
    try:
        try:
            if cancelled():
                terminal['outcome'] = 'cancelled'
        except Exception:
            terminal['outcome'] = 'environment_failure'
            terminal['failure'] = 'invalid_cancellation'
        terminal['retired'] = contained
        terminal['proof'] = 'linux_subreaper_echild' if contained else None
        terminal['self_digest'] = sha(encoded(terminal))
        # A terminal result is published once. Adoption never overwrites it.
        if not (root / 'terminal.json').exists():
            durable('terminal.json', terminal)
    finally:
        lock.rmdir()
