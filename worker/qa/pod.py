"""Runner-owned Docker pod. No repository command is executed on the host.

This module is embedded in rio-runner. Firewall configuration comes exclusively
from the runner host, never from a repository contract or a model tool call.
"""
import io
import base64
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import socket
import stat
import subprocess
import tarfile
import tempfile
import time
from urllib.parse import urlsplit


class PodError(RuntimeError):
    pass


def command(args, *, data=None, timeout=30, check=True):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if check and result.returncode:
        # Docker and app errors can contain credentials. The caller retains
        # only a named stage; raw stderr never enters the run record.
        raise PodError(f'{Path(args[0]).name} operation failed')
    return result


def docker(*args, **kwargs):
    return command(['docker', *args], **kwargs)


def safe_path(path):
    return (isinstance(path, str) and bool(path) and not path.startswith('/')
            and '\\' not in path and '\0' not in path
            and all(part not in ('', '.', '..') and part.lower() != '.git' for part in path.split('/')))


def snapshot_archive(source, destination):
    """Re-encode an immutable snapshot, rejecting links and archive tricks.

    No member is extracted onto the runner host. Numeric ownership ensures the
    app's unprivileged process can use the copied tree.
    """
    total, names, directories = 0, set(), {'repo'}
    with tarfile.open(fileobj=source, mode='r|*') as archive, tarfile.open(fileobj=destination, mode='w|') as output:
        directory = tarfile.TarInfo('repo')
        directory.type, directory.mode, directory.uid, directory.gid = tarfile.DIRTYPE, 0o755, 1000, 1000
        output.addfile(directory)
        for member in archive:
            if (not member.isreg() or not safe_path(member.name)
                    or member.mode not in (0o644, 0o755) or member.size > 64 * 1024 * 1024
                    or member.name in names):
                raise PodError('invalid_snapshot')
            ancestors = PurePosixPath(member.name).parents
            if any(str(parent) in names for parent in ancestors) or any(name.startswith(member.name + '/') for name in names):
                raise PodError('invalid_snapshot')
            total += member.size
            if total > 1024 * 1024 * 1024:
                raise PodError('snapshot_too_large')
            names.add(member.name)
            # Docker creates implicit archive parents as root. Materialize
            # every ancestor explicitly so nested app state/fixture paths stay
            # writable by the unprivileged application account.
            for parent in reversed(ancestors):
                if str(parent) == '.':
                    continue
                path = 'repo/' + str(parent)
                if path not in directories:
                    folder = tarfile.TarInfo(path)
                    folder.type, folder.mode, folder.uid, folder.gid = tarfile.DIRTYPE, 0o755, 1000, 1000
                    output.addfile(folder)
                    directories.add(path)
            safe = tarfile.TarInfo('repo/' + member.name)
            safe.size, safe.mode, safe.uid, safe.gid = member.size, member.mode, 1000, 1000
            output.addfile(safe, archive.extractfile(member))


def pin_endpoints(urls):
    if not isinstance(urls, list) or len(urls) > 32:
        raise PodError('invalid_egress_policy')
    endpoints = []
    for value in urls:
        parsed = urlsplit(value)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.fragment):
            raise PodError('invalid_egress_policy')
        port = parsed.port or 443
        addresses = sorted({entry[4][0] for entry in socket.getaddrinfo(parsed.hostname, port, socket.AF_INET, socket.SOCK_STREAM)})
        if not addresses:
            raise PodError('gateway_dns_failed')
        for address in addresses:
            if not ipaddress.ip_address(address).is_global:
                raise PodError('gateway_address_not_public')
            endpoints.append({'host': parsed.hostname, 'ip': address, 'port': port})
    return endpoints


def fixture_network(fixtures, app_port, control_port):
    """Allocate stable ports and validate claims before creating containers."""
    services = list(fixtures.get('services', []))
    for capture, kind in [('mail', 'smtp-capture'), ('sms', 'sms-capture'), ('webhooks', 'webhook-sink')]:
        if fixtures.get('capture', {}).get(capture) and not any(service['kind'] == kind for service in services):
            services.append({'name': 'capture-' + capture, 'kind': kind})
    ports, claims, routes, admitted = {}, set(), set(), set()
    candidate = 18000
    for service in services:
        if service['name'] in ports:
            raise PodError('duplicate_fixture_service')
        while candidate in {app_port, control_port}:
            candidate += 1
        if candidate > 65535:
            raise PodError('too_many_fixture_services')
        ports[service['name']] = candidate
        if service['kind'] not in {'smtp-capture', 'custom'}:
            admitted.add(candidate)
        candidate += 1
        for claim in service.get('claims', []):
            match = re.fullmatch(r'([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::(80|443))?', claim)
            if (not match or len(match[1]) > 253 or service['kind'] in {'smtp-capture', 'custom'}
                    or match[1].lower() in {'localhost', 'app', 'app.test', 'browser', 'controller', 'host.docker.internal', 'gateway.docker.internal'}):
                raise PodError('invalid_host_claim')
            host = match[1].lower()
            for port in [int(match[2])] if match[2] else [80, 443]:
                if (host, port) in routes or port in {app_port, control_port}:
                    raise PodError('conflicting_host_claim')
                routes.add((host, port))
                admitted.add(port)
            claims.add(host)
    if len(claims) > 256:
        raise PodError('too_many_host_claims')
    return ports, sorted(claims), sorted(admitted)


def fixture_certificate(claims):
    """The CA signing key never leaves this private host directory."""
    with tempfile.TemporaryDirectory(prefix='rio-qa-ca-') as directory:
        root = Path(directory)
        ca_key, ca, key, csr, cert = [root / name for name in ('ca.key', 'ca.crt', 'leaf.key', 'leaf.csr', 'leaf.crt')]
        command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ca_key), '-out', str(ca),
                 '-days', '2', '-subj', '/CN=Rio ephemeral QA CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
        command(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(csr), '-subj', '/CN=Rio QA fixture'])
        extension = root / 'extensions'
        extension.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=' + ','.join('DNS:' + host for host in claims) + '\n')
        command(['openssl', 'x509', '-req', '-in', str(csr), '-CA', str(ca), '-CAkey', str(ca_key), '-CAcreateserial',
                 '-out', str(cert), '-days', '1', '-extfile', str(extension)])
        public = command(['openssl', 'x509', '-in', str(cert), '-pubkey', '-noout']).stdout
        der = command(['openssl', 'pkey', '-pubin', '-outform', 'DER'], data=public).stdout
        return {'ca': ca.read_bytes(), 'key': key.read_bytes(), 'cert': cert.read_bytes(), 'spki': base64.b64encode(hashlib.sha256(der).digest()).decode()}


class Firewall:
    def __init__(self, run_id):
        self.chain = 'RIOQA' + run_id
        configured = os.environ.get('RIO_QA_FIREWALL_PREFIX')
        if configured:
            self.prefix = json.loads(configured)
            if not isinstance(self.prefix, list) or not all(isinstance(arg, str) for arg in self.prefix):
                raise PodError('invalid_host_firewall_configuration')
        else:
            info = json.loads(docker('info', '--format', '{{json .SecurityOptions}}').stdout)
            if 'name=rootless' in info:
                state = Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')) / 'dockerd-rootless'
                try:
                    pid = int((state / 'child_pid').read_text())
                except (ValueError, OSError):
                    raise PodError('no_runtime: configure RIO_QA_FIREWALL_PREFIX for this rootless daemon') from None
                self.prefix = ['sudo', '-n', 'nsenter', '-t', str(pid), '-U', f'--net=/proc/{pid}/root{state}/netns', '--']
            else:
                self.prefix = [] if os.geteuid() == 0 else ['sudo', '-n']
        rules = self.call('-S', 'FORWARD').stdout.decode()
        if '-j DOCKER-USER' not in rules:
            raise PodError('no_runtime: Docker iptables forwarding is required')
        bridge = command([*self.prefix, 'sysctl', '-n', 'net.bridge.bridge-nf-call-iptables'], check=False)
        if bridge.returncode or bridge.stdout.strip() != b'1':
            raise PodError('no_runtime: load br_netfilter and enable net.bridge.bridge-nf-call-iptables on the runner host')

    def call(self, *args, **kwargs):
        return command([*self.prefix, 'iptables', '-w', '5', *args], **kwargs)

    def install(self, pod_subnet, egress_subnet, app, browser, controller, external, app_port, endpoints, control_port=9224, service_ports=(), cdp_port=9223, files_port=9226):
        self.call('-N', self.chain)
        # Build a complete deny-by-default policy before linking it into hooks.
        def flow(source, destination, port):
            self.call('-A', self.chain, '-s', source, '-d', destination, '-p', 'tcp', '--dport', str(port), '-j', 'ACCEPT')
            self.call('-A', self.chain, '-s', destination, '-d', source, '-p', 'tcp', '--sport', str(port), '-m', 'conntrack', '--ctstate', 'ESTABLISHED', '-j', 'ACCEPT')
        flow(controller, browser, cdp_port)
        flow(controller, browser, files_port)
        flow(controller, app, control_port)
        flow(browser, app, app_port)
        for port in service_ports:
            flow(browser, app, port)
        for endpoint in endpoints:
            flow(external, endpoint['ip'], endpoint['port'])
        for role, address in [('app', app), ('browser', browser), ('controller', controller), ('controller-egress', external)]:
            self.call('-A', self.chain, '-s', address, '-m', 'comment', '--comment', f'blocked_egress:{role}', '-j', 'REJECT')
        self.call('-A', self.chain, '-j', 'REJECT')
        for subnet in (pod_subnet, egress_subnet):
            self.call('-I', 'DOCKER-USER', '1', '-s', subnet, '-j', self.chain)
            self.call('-I', 'DOCKER-USER', '1', '-d', subnet, '-j', self.chain)
            # Docker's internal networks alone do not block the host gateway.
            self.call('-I', 'INPUT', '1', '-s', subnet, '-j', self.chain)

    def rejections(self):
        result = self.call('-L', self.chain, '-n', '-v', '-x', check=False)
        events = []
        for line in result.stdout.decode().splitlines():
            match = re.search(r'^\s*(\d+)\s+\d+.*blocked_egress:([a-z-]+)', line)
            if match and int(match[1]):
                events.append({'kind': 'blocked_egress', 'source': match[2], 'packets': int(match[1])})
        return events

    def remove(self):
        for hook in ('DOCKER-USER', 'INPUT'):
            for line in self.call('-S', hook).stdout.decode().splitlines():
                args = shlex.split(line)
                if len(args) >= 2 and args[-2:] == ['-j', self.chain]:
                    self.call('-D', *args[1:])
        self.call('-F', self.chain, check=False)
        self.call('-X', self.chain, check=False)
        if self.call('-S', self.chain, check=False).returncode == 0:
            raise PodError('firewall_cleanup_failed')


class Pod:
    """A disposable pod; callers must close it even when startup fails.

    Application commands run only in app. Controller commands are supplied by
    trusted Rio code, never by the project manifest or the agent.
    """
    def __init__(self, run_id, *, qa_image, app_image, egress_urls=(), hosted=True, subscription_file=None, model_socket=None):
        if not re.fullmatch('[0-9a-f]{16}', run_id):
            raise PodError('invalid_run_id')
        for image in (qa_image, app_image):
            if not image or image.startswith('-') or any(c.isspace() for c in image):
                raise PodError('invalid_image')
        self.model_socket = None
        if model_socket is not None:
            if hosted or subscription_file is not None:
                raise PodError('local_model_relay_requires_local_gateway')
            try:
                path = Path(model_socket).resolve(strict=True)
                if not stat.S_ISSOCK(path.stat().st_mode):
                    raise ValueError()
                self.model_socket = path
            except (OSError, ValueError):
                raise PodError('local_model_relay_unavailable') from None
        self.subscription_file = None
        if subscription_file is not None:
            if hosted:
                raise PodError('subscription_requires_local_docker')
            try:
                path = Path(subscription_file).resolve(strict=True)
                if not path.is_file() or path.stat().st_size > 1024 * 1024:
                    raise ValueError()
                document = json.loads(path.read_bytes())
                if (not isinstance(document, dict) or document.get('OPENAI_API_KEY') is not None
                        or document.get('auth_mode', 'chatgpt') != 'chatgpt'
                        or not isinstance(document.get('tokens'), dict)
                        or not isinstance(document['tokens'].get('access_token'), str)
                        or not document['tokens']['access_token'].strip()):
                    raise ValueError()
                self.subscription_file = path
            except (OSError, ValueError):
                raise PodError('subscription_unavailable') from None
            egress_urls = [*egress_urls, 'https://chatgpt.com', 'https://auth.openai.com']
        self.name = 'rio-qa-' + run_id
        self.qa_image, self.app_image = qa_image, app_image
        self.containers = {role: self.name + '-' + role for role in ('app', 'browser', 'controller')}
        self.networks = [self.name + '-pod', self.name + '-egress']
        self.volume = self.name + '-snapshot'
        self.firewall = Firewall(run_id)
        self.endpoints = pin_endpoints(list(egress_urls))
        self.policy = {'egress': 'host_firewall_pinned', 'app_isolation': 'container', 'destinations': self.endpoints}

    def create(self, *, snapshot, app_command, app_port, assets, controller_command, app_runtime=None, app_credentials=None, app_hooks=None):
        if not isinstance(app_port, int) or not 1 <= app_port <= 65535:
            raise PodError('invalid_app_port')
        for argv in (app_command, controller_command):
            if (not isinstance(argv, list) or not 1 <= len(argv) <= 128
                    or not all(isinstance(arg, str) and '\0' not in arg and len(arg) <= 16000 for arg in argv)
                    or not argv[0]):
                raise PodError('invalid_container_command')
        # Explicitly admitted artifacts only: no arbitrary source bundle can be
        # copied into the harness container through this interface.
        allowed = {'contract.json', 'journeys.json', 'fixtures.json', 'owner-guidance.json', 'plan.json', 'run.json'}
        if not set(assets) <= allowed:
            raise PodError('invalid_controller_asset')
        self.control_port = 9224 if app_port != 9224 else 9225
        exposed_port, loopback_app = app_port, False
        cdp_port, debug_port, files_port = 9223, 9222, 9226
        claims, admitted, certificate = [], [], None
        if app_runtime is not None:
            if app_hooks is None:
                raise PodError('missing_app_hooks')
            app_runtime = json.loads(json.dumps(app_runtime))
            app_runtime['image'] = self.app_image
            service_ports, claims, admitted = fixture_network(app_runtime.get('fixtures', {}), app_port, self.control_port)
            app_runtime['service_ports'] = service_ports
            if claims:
                certificate = fixture_certificate(claims)
                app_runtime['fixture_tls'] = True
            app = app_runtime['contract']['app']
            loopback_app = urlsplit(app['url']).hostname in {'localhost', '127.0.0.1'}
            if loopback_app:
                exposed_port = next(port for port in range(17000, 18000) if port not in {app_port, self.control_port})
                app_runtime['app_forward_port'] = exposed_port
                cdp_port = 9233 if app_port == 9223 else 9223
                debug_port = 9232 if app_port == 9222 else 9222
                files_port = 9236 if app_port == 9226 else 9226
            if app.get('packaging') == 'image' and not app.get('start'):
                app['start'] = shlex.join(app_command)
            app_command = ['node', '/opt/rio-qa-app/app-entrypoint.mjs']
            if claims:
                app_command = ['python3', '-I', '/opt/rio-qa-bootstrap/entrypoint.py', *app_command]
        label = 'rio.qa.run=' + self.name
        subnets = []
        for index, network in enumerate(self.networks):
            args = ['network', 'create', '--label', label, '--opt', 'com.docker.network.bridge.enable_icc=false']
            if index == 0:
                args.append('--internal')
            docker(*args, network)
            document = json.loads(docker('network', 'inspect', network).stdout)[0]
            subnet = ipaddress.ip_network(document['IPAM']['Config'][0]['Subnet'])
            if subnet.version != 4 or subnet.num_addresses < 8:
                raise PodError('unsupported_docker_network')
            # Docker before 29 accepts --ip only on a user-configured subnet:
            # pin the free subnet Docker just allocated.
            docker('network', 'rm', network)
            docker(*args, '--subnet', str(subnet), network)
            subnets.append(subnet)
        app, browser, controller = [str(subnets[0][index]) for index in (2, 3, 4)]
        external = str(subnets[1][2])
        self.addresses = {'app': app, 'browser': browser, 'controller': controller, 'external': external}
        docker('volume', 'create', '--label', label, self.volume)
        self.firewall.install(str(subnets[0]), str(subnets[1]), app, browser, controller, external, exposed_port, self.endpoints, self.control_port, admitted, cdp_port, files_port)
        for role in self.containers:
            args = ['create', '--name', self.containers[role], '--label', label,
                    '--init', '--user', '1000:1000', '--cap-drop', 'ALL',
                    '--security-opt', 'no-new-privileges', '--pids-limit', '256',
                    '--memory', '2g', '--shm-size', '256m', '--network', self.networks[0],
                    '--ip', self.addresses[role], '--dns', app if role == 'app' and app_runtime is not None else '127.0.0.1',
                    '--dns-search', '.', '--dns-option', 'ndots:1',
                    '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1',
                    '--sysctl', 'net.ipv6.conf.default.disable_ipv6=1',
                    '--add-host', f'app:{app}', '--add-host', f'app.test:{app}', '--add-host', f'browser:{browser}']
            if role == 'app':
                if claims:
                    args += ['--user', '0:0', '--cap-add', 'CHOWN', '--cap-add', 'SETUID', '--cap-add', 'SETGID',
                             '--env', 'NODE_EXTRA_CA_CERTS=/run/rio/ca.crt',
                             '--env', 'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt',
                             '--env', 'REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt']
                args += ['--mount', f'type=volume,src={self.volume},dst=/work', '--workdir', '/work/repo',
                         '--env', 'RIO_QA_CONTAINER=app', '--env', f'RIO_QA_CONTROL_PORT={self.control_port}',
                         '--entrypoint', app_command[0], self.app_image, *app_command[1:]]
            elif role == 'browser':
                args += ['--env', f'RIO_QA_CDP_PORT={cdp_port}', '--env', f'RIO_QA_DEBUG_PORT={debug_port}', '--env', f'RIO_QA_BROWSER_FILES_PORT={files_port}']
                if loopback_app:
                    args += ['--env', f'RIO_QA_APP_FORWARD_FROM={app_port}', '--env', f'RIO_QA_APP_FORWARD_TO={exposed_port}']
                for host in claims:
                    args += ['--add-host', f'{host}:{app}']
                if certificate:
                    args += ['--env', 'RIO_QA_FIXTURE_SPKI=' + certificate['spki']]
                args += ['--entrypoint', 'node', self.qa_image, '/opt/rio-qa/src/browser-server.mjs']
            else:
                if self.model_socket:
                    args += ['--mount', f'type=bind,src={self.model_socket},dst=/run/rio/model.sock,readonly',
                             '--env', 'RIO_QA_MODEL_SOCKET=/run/rio/model.sock']
                if self.subscription_file:
                    # Only trusted bootstrap runs as root; all harness/model
                    # code starts after the permanent uid/capability drop.
                    args += ['--user', '0:0', '--cap-add', 'CHOWN', '--cap-add', 'DAC_READ_SEARCH',
                             '--cap-add', 'SETUID', '--cap-add', 'SETGID',
                             '--mount', f'type=bind,src={self.subscription_file},dst=/run/rio/subscription.json,readonly',
                             '--tmpfs', '/run/rio/auth:rw,noexec,nosuid,nodev,mode=0700,uid=0,gid=0',
                             '--env', 'RIO_QA_SUBSCRIPTION_FILE=/run/rio/auth/auth.json']
                    controller_command = ['python3', '/opt/rio-qa/subscription-entrypoint.py', *controller_command]
                for endpoint in self.endpoints:
                    args += ['--add-host', f'{endpoint["host"]}:{endpoint["ip"]}']
                args += ['--env', 'RIO_QA_CONTAINER=controller', '--env', f'RIO_QA_BROWSER=http://{browser}:{cdp_port}', '--env', f'RIO_QA_APP=http://{app}:{exposed_port}',
                         '--env', f'RIO_QA_BROWSER_FILES=http://{browser}:{files_port}',
                         '--env', f'RIO_QA_APP_CONTROL=http://{app}:{self.control_port}',
                         '--entrypoint', controller_command[0], self.qa_image, *controller_command[1:]]
            docker(*args)
        docker('network', 'connect', '--ip', external, '--gw-priority', '1', self.networks[1], self.containers['controller'])
        with tempfile.TemporaryFile() as archive:
            snapshot_archive(snapshot, archive)
            archive.seek(0)
            # docker cp streams into a stopped container; no app process can
            # race extraction. Only the named volume receives repository data.
            result = subprocess.run(['docker', 'cp', '-a', '-', self.containers['app'] + ':/work'], stdin=archive, capture_output=True, timeout=120)
            if result.returncode:
                raise PodError('snapshot_materialization_failed')
        if app_runtime is not None:
            payload = io.BytesIO()
            with tarfile.open(fileobj=payload, mode='w') as archive:
                files = {name: (Path(app_hooks) / name).read_bytes() for name in ('app-entrypoint.mjs', 'app-runtime.mjs', 'seed-runtime.mjs', 'seed-transfer.mjs', 'datastores.mjs', 'seed-archive.py', 'context.mjs', 'static-server.mjs', 'fixture-services.mjs', 'fixture-providers.mjs', 'fixture-files.mjs', 'tcp-relay.mjs')}
                files['runtime.json'] = json.dumps(app_runtime).encode()
                files['credentials.json'] = json.dumps(app_credentials or {}).encode()
                if certificate:
                    files['tls-key.pem'], files['tls-cert.pem'] = certificate['key'], certificate['cert']
                folder = tarfile.TarInfo('rio-qa-app')
                folder.type, folder.mode, folder.uid, folder.gid = tarfile.DIRTYPE, 0o700, 1000, 1000
                archive.addfile(folder)
                for name, content in files.items():
                    item = tarfile.TarInfo('rio-qa-app/' + name)
                    item.size, item.mode, item.uid, item.gid = len(content), 0o400, 1000, 1000
                    archive.addfile(item, io.BytesIO(content))
            docker('cp', '-a', '-', self.containers['app'] + ':/opt', data=payload.getvalue())
            if certificate:
                # Root bootstrap and public trust data are separate from the
                # node-owned hooks directory. No repository file runs as root.
                payload = io.BytesIO()
                with tarfile.open(fileobj=payload, mode='w') as archive:
                    for name, content in {
                        'opt/rio-qa-bootstrap/entrypoint.py': (Path(__file__).parent / 'entrypoint.py').read_bytes(),
                        'run/rio/bootstrap.json': json.dumps({'claims': claims}).encode(),
                        'run/rio/ca.crt': certificate['ca'],
                    }.items():
                        item = tarfile.TarInfo(name)
                        item.size, item.mode, item.uid, item.gid = len(content), 0o444, 0, 0
                        archive.addfile(item, io.BytesIO(content))
                docker('cp', '-a', '-', self.containers['app'] + ':/', data=payload.getvalue())
        payload = io.BytesIO()
        with tarfile.open(fileobj=payload, mode='w') as archive:
            for name, value in {**assets, 'credentials.json': app_credentials or {}}.items():
                content = json.dumps(value).encode()
                if len(content) > 16 * 1024 * 1024:
                    raise PodError('controller_asset_too_large')
                item = tarfile.TarInfo(name)
                item.size, item.mode, item.uid, item.gid = len(content), 0o400, 1000, 1000
                archive.addfile(item, io.BytesIO(content))
        docker('cp', '-a', '-', self.containers['controller'] + ':/home/node', data=payload.getvalue())

    def start(self):
        for role in ('app', 'browser', 'controller'):
            docker('start', self.containers[role])

    def wait(self, wall_seconds, cancelled=lambda: False, tick=lambda: None):
        deadline = time.monotonic() + wall_seconds
        while not cancelled() and time.monotonic() < deadline:
            tick()
            state = json.loads(docker('inspect', '--format', '{{json .State}}', self.containers['controller']).stdout)
            if not state['Running']:
                return {'outcome': 'complete' if state['ExitCode'] == 0 else 'failed', 'exit_code': state['ExitCode'], 'policy': self.policy, 'network_events': self.firewall.rejections()}
            time.sleep(0.2)
        return {'outcome': 'partial', 'reason': 'interrupted' if cancelled() else 'budget', 'policy': self.policy, 'network_events': self.firewall.rejections()}

    def close(self):
        # Stop repository code before removing its isolation policy.
        for name in self.containers.values():
            docker('rm', '--force', name, check=False)
            if docker('inspect', name, check=False).returncode == 0:
                raise PodError('pod_cleanup_failed')
        self.firewall.remove()
        for name in self.networks:
            docker('network', 'rm', name, check=False)
            if docker('network', 'inspect', name, check=False).returncode == 0:
                raise PodError('network_cleanup_failed')
        docker('volume', 'rm', self.volume, check=False)
        if docker('volume', 'inspect', self.volume, check=False).returncode == 0:
            raise PodError('volume_cleanup_failed')


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Trusted QA pod cleanup')
    parser.add_argument('--cleanup', required=True)
    args = parser.parse_args()
    Pod(args.cleanup, qa_image='unused', app_image='unused').close()
