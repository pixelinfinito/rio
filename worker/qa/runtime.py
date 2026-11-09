"""Trusted host entrypoint shared by local QA and the self-hosted runner.

Only Docker receives repository bytes or commands. Host files below root are
created by Rio; repository archives are never extracted on the host.
"""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import shutil
import tempfile
import subprocess
import tarfile
import threading
import time
import uuid
from urllib.parse import urlsplit

from pod import Pod, PodError, docker, safe_path

RESULT_LIMIT = 12 * 1024 * 1024


def write_json(path, value):
    pending = path.with_suffix('.pending')
    with open(pending, 'w', encoding='utf-8') as output:
        os.chmod(pending, 0o600)
        json.dump(value, output, separators=(',', ':'))
    os.replace(pending, path)


def prepare(root, configuration):
    app = configuration['contract']['app']
    image = configuration['qa_image']
    if app['packaging'] == 'image':
        dockerfile = app.get('dockerfile')
        if not safe_path(dockerfile):
            raise PodError('invalid_dockerfile')
        # The immutable archive is the entire build context. Neither host paths
        # nor persona/model credentials are offered to the build process.
        with open(root / 'snapshot.tar', 'rb') as archive:
            result = subprocess.run(['docker', 'build', '--quiet', '--force-rm', '--file', dockerfile,
                                     '--iidfile', str(root / 'image-id'), '-'], stdin=archive,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    timeout=configuration['wall_ms'] / 1000)
        if result.returncode:
            raise PodError('image_build_failed')
        image = (root / 'image-id').read_text().strip()
    document = json.loads(docker('image', 'inspect', image).stdout)[0]
    digest = document['Id']
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
        raise PodError('invalid_image_digest')
    settings = document.get('Config') or {}
    command = (settings.get('Entrypoint') or []) + (settings.get('Cmd') or [])
    if not command:
        command = ['true']  # static/vendored use the contract's own start command
    write_json(root / 'image.json', {'image': digest, 'command': command})


def controller_archive(container, path, consume, timeout=30):
    process = subprocess.Popen(['docker', 'cp', container + ':' + path, '-'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    expired = threading.Event()
    def terminate():
        expired.set()
        try:
            process.kill()
        except ProcessLookupError:
            pass
    # The deadline must include reading the tar stream. Waiting with a timeout
    # only after consume() leaves a stalled Docker pipe unbounded.
    timer = threading.Timer(timeout, terminate)
    timer.start()
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
            value = consume(archive)
        process.stdout.close()
        if process.wait(timeout=timeout) or expired.is_set():
            raise PodError('controller_export_failed')
        return value
    finally:
        timer.cancel()
        timer.join()
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait()


def read_result(container):
    def consume(archive):
        entries = iter(archive)
        member = next(entries, None)
        if member is None or not member.isreg() or member.size > RESULT_LIMIT:
            raise PodError('invalid_controller_result')
        value = json.load(archive.extractfile(member))
        if next(entries, None) is not None:
            raise PodError('invalid_controller_result')
        if not isinstance(value, dict) or not isinstance(value.get('journey_outcomes'), list):
            raise PodError('invalid_controller_result')
        return value
    try:
        return controller_archive(container, '/home/node/qa-result.json', consume)
    except (tarfile.ReadError, PodError):
        return None


def private_directory(path):
    path = path.absolute()
    at = Path(path.anchor)
    for part in path.parts[1:]:
        at /= part
        at.mkdir(exist_ok=True, mode=0o700)
        if at.is_symlink() or not at.is_dir():
            raise PodError('invalid_cache_directory')


@contextmanager
def seed_cache_lock(cache):
    private_directory(cache)
    descriptor = os.open(cache / '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise PodError('invalid_seed_cache')
        # Same advisory lock as LocalSeedBackend: pruning and manifest
        # publication cannot race a host import/export. Crashes release it.
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


class SeedCacheLease:
    """The host snapshot remains pinned while its private pod copy is in use."""
    def __init__(self, cache, fingerprint, ttl=180, interval=60):
        if not re.fullmatch('[a-f0-9]{64}', fingerprint):
            raise PodError('invalid_seed_fingerprint')
        self.cache, self.fingerprint, self.ttl, self.interval = cache, fingerprint, ttl, interval
        self.path = cache / 'leases' / (str(uuid.uuid4()) + '.json')
        self.stopped, self.failed = threading.Event(), threading.Event()
        self.thread = None

    def refresh(self):
        with seed_cache_lock(self.cache):
            private_directory(self.path.parent)
            write_json(self.path, {'fingerprint': self.fingerprint, 'parts': [],
                                  'expires_at_ms': int((time.time() + self.ttl) * 1000)})

    def start(self):
        self.refresh()
        def heartbeat():
            while not self.stopped.wait(self.interval):
                try:
                    self.refresh()
                except Exception:
                    self.failed.set()
                    return
        self.thread = threading.Thread(target=heartbeat, daemon=True)
        self.thread.start()
        return self

    def close(self):
        self.stopped.set()
        if self.thread:
            self.thread.join()
        with seed_cache_lock(self.cache):
            self.path.unlink(missing_ok=True)


def export_seeds(container, destination, maximum):
    private_directory(destination)
    # Never publish a manifest while its parts are still arriving. Interrupted
    # exports leave the previous cache intact; controller leases stay private.
    with tempfile.TemporaryDirectory(prefix='.export-', dir=destination) as directory:
        staging = Path(directory) / 'qa-seeds'
        export_directory(container, '/home/node/qa-seeds', staging, maximum)
        manifests = []
        for path in staging.glob('*/manifest.json'):
            if not re.fullmatch('[a-f0-9]{64}', path.parent.name):
                raise PodError('invalid_seed_cache')
            manifest = json.loads(path.read_bytes())
            if manifest.get('fingerprint', {}).get('fingerprint') != path.parent.name:
                raise PodError('invalid_seed_cache')
            for archive in manifest.get('archives', []):
                for part in archive['parts']:
                    if not re.fullmatch('[a-f0-9]{64}', part['hash']):
                        raise PodError('invalid_seed_cache')
                    source = staging / 'objects' / part['hash']
                    if not source.is_file() or source.stat().st_size != part['bytes']:
                        raise PodError('invalid_seed_cache')
            manifests.append(path)
        with seed_cache_lock(destination):
            objects = destination / 'objects'
            private_directory(objects)
            for source in (staging / 'objects').glob('*'):
                if not re.fullmatch('[a-f0-9]{64}', source.name) or not source.is_file():
                    raise PodError('invalid_seed_cache')
                # The controller verified the content hashes before publishing.
                # Parts are immutable; os.replace also repairs a corrupt cache.
                os.replace(source, objects / source.name)
            for source in manifests:
                target = destination / source.parent.name
                private_directory(target)
                os.replace(source, target / 'manifest.json')


def export_directory(container, source, destination, maximum):
    # Output is limited to regular files under one trusted controller directory.
    # Never use extractall: links and path tricks cannot write outside the cache.
    private_directory(destination)
    def consume(archive):
        total, count = 0, 0
        for member in archive:
            count += 1
            parts = member.name.rstrip('/').split('/')
            relative = '/'.join(parts[1:])
            if parts[0] != source.rsplit('/', 1)[-1] or (relative and not safe_path(relative)) or count > 100000:
                raise PodError('invalid_controller_export')
            target = destination.joinpath(*parts[1:])
            if member.isdir():
                private_directory(target)
                continue
            total += member.size
            if not member.isreg() or total > maximum:
                raise PodError('controller_export_too_large')
            private_directory(target.parent)
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
                temporary = Path(output.name)
                try:
                    shutil.copyfileobj(archive.extractfile(member), output)
                    output.flush()
                    os.replace(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
    controller_archive(container, source, consume)


def local_outputs(root, pod, value):
    assets = json.loads((root / 'assets.json').read_text())
    run = assets['run.json']
    if run['storage']['kind'] != 'local':
        return
    config = json.loads((root / 'runtime.json').read_text())
    cache = Path(config['local_cache'])
    review, record_run = run['review_id'], run.get('record_run_id', run['run_id'])
    if not all(isinstance(value, str) and re.fullmatch('[A-Za-z0-9_.-]+', value) and value not in {'.', '..'} for value in (review, record_run, run['run_id'])):
        raise PodError('invalid_evidence_record_path')
    evidence = cache / review / 'runs' / record_run / 'qa'
    if run.get('snapshot_version') == 'base':
        evidence /= 'baseline'
    source = f"/home/node/qa-evidence/{review}/runs/{run['run_id']}/qa"
    failures = []
    try:
        export_directory(pod.containers['controller'], source, evidence, run['budget']['evidence_bytes'] + 16 * 1024 ** 2)
    except Exception:
        failures.append('evidence')
    try:
        export_seeds(pod.containers['controller'], cache / 'qa-seeds', config['seed_cache_bytes'])
    except Exception:
        failures.append('seeds')
    def relocate(item):
        if isinstance(item, dict):
            for key, child in item.items():
                if key == 'link' and isinstance(child, str) and child.startswith(source + '/'):
                    item[key] = str(evidence / child.removeprefix(source + '/'))
                else:
                    relocate(child)
        elif isinstance(item, list):
            for child in item:
                relocate(child)
    relocate(value)
    manifest = evidence / 'manifest.json'
    if isinstance(value.get('evidence'), dict) and manifest.is_file() and not manifest.is_symlink():
        write_json(manifest, value['evidence'])
    if failures:
        raise PodError('local_cache_export_failed')


def import_seeds(pod, configuration):
    cache = Path(configuration['local_cache']) / 'qa-seeds'
    if not cache.exists():
        return
    # The pod receives its own immutable copy. Once this transfer completes,
    # host pruning cannot invalidate a running chain's snapshot.
    with seed_cache_lock(cache):
        _import_seeds(pod, configuration, cache)


def _import_seeds(pod, configuration, cache):
    private_directory(cache)
    # Leases belong to individual runs and are never imported. Manifests and
    # parts are verified again by SeedStore before a restore can commit.
    with tempfile.TemporaryFile() as output:
        total = 0
        with tarfile.open(fileobj=output, mode='w') as archive:
            directories = set()
            def directory(name):
                if name in directories:
                    return
                member = tarfile.TarInfo(name)
                member.type, member.mode, member.uid, member.gid = tarfile.DIRTYPE, 0o700, 1000, 1000
                archive.addfile(member)
                directories.add(name)
            directory('qa-seeds')
            for path in cache.rglob('*'):
                relative = path.relative_to(cache).as_posix()
                if path.is_symlink():
                    raise PodError('invalid_seed_cache')
                if not path.is_file() or not (re.fullmatch(r'objects/[a-f0-9]{64}', relative) or re.fullmatch(r'[a-f0-9]{64}/manifest.json', relative)):
                    continue
                total += path.stat().st_size
                if total > configuration['seed_cache_bytes']:
                    raise PodError('seed_cache_too_large')
                directory('qa-seeds/' + relative.split('/')[0])
                member = tarfile.TarInfo('qa-seeds/' + relative)
                member.size, member.mode, member.uid, member.gid = path.stat().st_size, 0o600, 1000, 1000
                with path.open('rb') as source:
                    archive.addfile(member, source)
        output.seek(0)
        result = subprocess.run(['docker', 'cp', '-a', '-', pod.containers['controller'] + ':/home/node'], stdin=output,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
        if result.returncode:
            raise PodError('seed_cache_import_failed')


def collect(root, pod, state=None):
    value = read_result(pod.containers['controller'])
    if value is None:
        value = {'outcome': 'partial', 'journey_outcomes': [], 'controller_error': 'controller_result_unavailable'}
    if state and state.get('outcome') != 'complete':
        value['outcome'] = 'partial'
        value['runtime_reason'] = state.get('reason', 'controller_failed')
    value['policy'] = pod.policy
    if state:
        value['network_events'] = value.get('network_events', []) + state.get('network_events', [])
    try:
        local_outputs(root, pod, value)
    except Exception:
        value['outcome'] = 'partial'
        value['runtime_reason'] = 'local_cache_export_failed'
    write_json(root / 'result.json', value)


def run(root, configuration):
    (root / 'result.json').unlink(missing_ok=True)
    (root / 'runtime-error.json').unlink(missing_ok=True)
    image = json.loads((root / 'image.json').read_text())
    assets = json.loads((root / 'assets.json').read_text())
    contract, run = assets['contract.json'], assets['run.json']
    credentials = json.loads((root / 'credentials.json').read_text())
    hosted = run['storage']['kind'] == 'hosted'
    pod = Pod(configuration['pod_id'], qa_image=configuration['qa_image'], app_image=image['image'],
              hosted=hosted, egress_urls=configuration.get('egress_urls', []),
              model_socket=configuration.get('model_socket'), subscription_file=configuration.get('subscription_file'))
    interrupted = False
    lease = None
    parent = configuration.get('parent_pid', os.getppid())
    cancelled = lambda: interrupted or (root / 'cancel').exists() or os.getppid() != parent or (lease and lease.failed.is_set())
    def stop(*_):
        nonlocal interrupted
        interrupted = True
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)
    try:
        if not hosted:
            lease = SeedCacheLease(Path(configuration['local_cache']) / 'qa-seeds', run['seed_fingerprint']['fingerprint']).start()
        parsed = urlsplit(contract['app']['url'])
        app_port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        with open(root / 'snapshot.tar', 'rb') as snapshot:
            pod.create(snapshot=snapshot, app_command=image['command'], app_port=app_port, assets=assets,
                       controller_command=['node', '/opt/rio-qa/src/controller-entrypoint.mjs'], app_hooks=root / 'hooks',
                       app_credentials=credentials, app_runtime={'contract': contract, 'fixtures': assets['fixtures.json'],
                       'seed': run['seed'], 'seed_fingerprint': run['seed_fingerprint'], 'seed_transfer': True})
        if cancelled():
            collect(root, pod, {'outcome': 'partial', 'reason': 'interrupted'})
            return
        if not hosted:
            import_seeds(pod, configuration)
        pod.start()
        state = pod.wait(run['budget']['wall_ms'] / 1000, cancelled)
        if lease and lease.failed.is_set():
            state = {**state, 'outcome': 'partial', 'reason': 'seed_lease_failed'}
        if state['outcome'] == 'partial':
            # Give the trusted controller time to close traces and flush its
            # checkpoint. Repository processes remain behind the firewall.
            docker('stop', '--time', '15', pod.containers['controller'], check=False, timeout=25)
        collect(root, pod, state)
    except Exception:
        # A Docker transport failure must not discard an existing checkpoint.
        try:
            collect(root, pod, {'outcome': 'partial', 'reason': 'runtime_failed'})
        except Exception:
            pass
        raise
    finally:
        try:
            pod.close()
        finally:
            if lease:
                lease.close()


def recover(root, configuration):
    # Independent fallback after the supervising process was killed. Collection
    # precedes deletion; cleanup is checked even if the result is unavailable.
    image = json.loads((root / 'image.json').read_text()) if (root / 'image.json').exists() else {'image': 'unused'}
    pod = Pod(configuration['pod_id'], qa_image=configuration['qa_image'], app_image=image['image'])
    try:
        if not (root / 'result.json').exists():
            docker('stop', '--time', '10', pod.containers['controller'], check=False, timeout=20)
            collect(root, pod, {'outcome': 'partial', 'reason': 'interrupted'})
    finally:
        pod.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', choices=['prepare', 'run', 'recover'])
    args = parser.parse_args()
    root = Path.cwd()
    try:
        configuration = json.loads((root / 'runtime.json').read_text())
        {'prepare': prepare, 'run': run, 'recover': recover}[args.stage](root, configuration)
    except Exception as error:
        # No raw Docker/app output, URLs, environment or credentials in logs.
        reason = str(error) if isinstance(error, PodError) else 'runtime_failed'
        write_json(root / 'runtime-error.json', {'reason': reason})
        raise SystemExit(1)
