import io
import json
import os
from pathlib import Path
import secrets
import tarfile
import time
import unittest

from pod import Pod, PodError, docker, snapshot_archive, fixture_network, fixture_certificate


def archive_files(files):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode='w') as archive:
        for name, content in files.items():
            item = tarfile.TarInfo(name)
            item.mode, item.size = 0o644, len(content)
            archive.addfile(item, io.BytesIO(content))
    result.seek(0)
    return result


class ArchiveTests(unittest.TestCase):
    def test_fixture_ports_and_host_claims_are_scoped(self):
        fixtures = {'services': [{'name': 'payments', 'kind': 'http-mock', 'claims': ['payments.example.test']}], 'capture': {'mail': True}}
        ports, claims, admitted = fixture_network(fixtures, 18000, 9224)
        self.assertEqual(ports, {'payments': 18001, 'capture-mail': 18002})
        self.assertEqual(claims, ['payments.example.test'])
        self.assertEqual(admitted, [80, 443, 18001])
        for claim in ['controller', 'example.test:8443', 'bad\ncontroller', 'host.docker.internal']:
            with self.assertRaises(PodError):
                fixture_network({'services': [{'name': 'double', 'kind': 'http-mock', 'claims': [claim]}]}, 4173, 9224)

    def test_run_certificate_exports_only_leaf_private_key(self):
        import subprocess
        import tempfile
        certificate = fixture_certificate(['payments.example.test'])
        self.assertEqual(set(certificate), {'key', 'cert', 'ca', 'spki'})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'ca').write_bytes(certificate['ca'])
            (root / 'cert').write_bytes(certificate['cert'])
            result = subprocess.run(['openssl', 'verify', '-CAfile', str(root / 'ca'), '-verify_hostname', 'payments.example.test', str(root / 'cert')], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(certificate['spki']), 44)

    def test_snapshot_rejects_escape_symlink_and_file_directory_collision(self):
        for files in ({'../escape': b'x'}, {'a': b'x', 'a/b': b'x'}, {'a/b': b'x', 'a': b'x'}, {'.git/config': b'x'}):
            with self.assertRaises(PodError):
                snapshot_archive(archive_files(files), io.BytesIO())
        source = io.BytesIO()
        with tarfile.open(fileobj=source, mode='w') as archive:
            item = tarfile.TarInfo('link')
            item.type, item.linkname = tarfile.SYMTYPE, '/etc'
            archive.addfile(item)
        source.seek(0)
        with self.assertRaises(PodError):
            snapshot_archive(source, io.BytesIO())

    def test_materialized_files_are_owned_by_app_user(self):
        output = io.BytesIO()
        snapshot_archive(archive_files({'app/main.js': b'content', '.rio/qa/fixtures/fixtures.yaml': b'version: 1'}), output)
        output.seek(0)
        with tarfile.open(fileobj=output) as archive:
            members = list(archive)
            self.assertTrue(all(member.uid == 1000 and member.gid == 1000 for member in members))
            self.assertEqual({member.name for member in members if member.isdir()},
                             {'repo', 'repo/app', 'repo/.rio', 'repo/.rio/qa', 'repo/.rio/qa/fixtures'})


@unittest.skipUnless(os.environ.get('RIO_TEST_QA_DOCKER') == '1', 'requires Docker and host firewall control')
class PodTests(unittest.TestCase):
    def test_network_boundaries_remote_browser_and_interruption_cleanup(self):
        image = os.environ.get('RIO_QA_IMAGE', 'rio-qa:0.1.0')
        pod = Pod(os.environ.get('RIO_QA_TEST_RUN_ID') or secrets.token_hex(8), qa_image=image, app_image=image, egress_urls=['https://1.1.1.1'])
        snapshot = archive_files({
            'app.js': b"require('node:http').createServer((q,s)=>s.end('<title>QA pod</title><button>Snapshot app</button>')).listen(8080,'0.0.0.0')",
            'repo-marker.txt': b'source belongs only in app',
        })
        try:
            pod.create(snapshot=snapshot, app_command=['node', 'app.js'], app_port=8080,
                       assets={'owner-guidance.json': {'guidance': []}},
                       controller_command=['node', '-e', "require('node:http').createServer((q,s)=>s.end('model route')).listen(9123,'0.0.0.0')"])
            pod.start()
            def node(role, script):
                return docker('exec', pod.containers[role], 'node', '--input-type=module', '-e', script).stdout.decode().strip()

            def connects(role, host, port):
                script = f"import net from 'node:net'; const s=net.connect({port},{json.dumps(host)}); s.setTimeout(1500); s.on('connect',()=>{{console.log('connected');s.destroy()}}); s.on('error',()=>console.log('blocked')); s.on('timeout',()=>{{console.log('blocked');s.destroy()}});"
                return node(role, script) == 'connected'

            for _ in range(30):
                if connects('controller', pod.addresses['browser'], 9223):
                    break
                time.sleep(0.2)
            self.assertTrue(connects('controller', '127.0.0.1', 9123), 'test model route must be listening')
            self.assertFalse(connects('app', pod.addresses['controller'], 9123))
            self.assertFalse(connects('browser', pod.addresses['controller'], 9123))
            self.assertFalse(connects('app', '1.1.1.1', 443))
            self.assertFalse(connects('browser', '1.1.1.1', 443))
            self.assertTrue(connects('controller', '1.1.1.1', 443), 'pinned gateway must be reachable')
            self.assertFalse(connects('controller', '1.0.0.1', 443))
            self.assertFalse(connects('controller', pod.addresses['app'], 8080))
            self.assertEqual(node('controller', "import fs from 'node:fs'; console.log(fs.existsSync('/work/repo/repo-marker.txt'));"), 'false')
            self.assertEqual(node('browser', "import fs from 'node:fs'; console.log(fs.existsSync('/work/repo/repo-marker.txt'));"), 'false')
            self.assertEqual(node('app', "import fs from 'node:fs'; console.log(fs.readFileSync('/work/repo/repo-marker.txt','utf8'));"), 'source belongs only in app')
            info = json.loads(docker('inspect', pod.containers['app']).stdout)[0]
            self.assertFalse(any(mount['Type'] == 'bind' for mount in info['Mounts']))
            self.assertEqual(node('app', "import fs from 'node:fs';fs.writeFileSync('/work/repo/generated.txt','ok');console.log(process.getuid());"), '1000')
            observed = node('controller', "import { openBrowser } from '/opt/rio-qa/src/browser.mjs'; const b=await openBrowser({endpoint:process.env.RIO_QA_BROWSER,viewport:{width:390,height:844,mobile:true,touch:true}});try{await b.page.goto(process.env.RIO_QA_APP);console.log(await b.page.title())}finally{await b.close()}")
            self.assertEqual(observed, 'QA pod')
            outcome = pod.wait(5, cancelled=lambda: True)
            self.assertEqual(outcome['reason'], 'interrupted')
            self.assertTrue(any(event['source'] == 'controller-egress' for event in outcome['network_events']))
        finally:
            pod.close()
        for name in pod.containers.values():
            self.assertNotEqual(docker('inspect', name, check=False).returncode, 0)
        for name in pod.networks:
            self.assertNotEqual(docker('network', 'inspect', name, check=False).returncode, 0)
        self.assertNotEqual(docker('volume', 'inspect', pod.volume, check=False).returncode, 0)


if __name__ == '__main__':
    unittest.main()
