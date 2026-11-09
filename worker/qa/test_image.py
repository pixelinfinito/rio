"""Integration check for the trusted QA image bootstrap (requires Docker)."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class QaImageTests(unittest.TestCase):
    def test_bootstrap_installs_public_ca_and_claims_then_drops_privileges(self):
        image = os.environ.get('RIO_QA_IMAGE', 'rio-qa:0.1.0')
        with tempfile.TemporaryDirectory(prefix='rio-qa-bootstrap-') as directory:
            root = Path(directory)
            subprocess.run([
                'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                '-keyout', str(root / 'key.pem'), '-out', str(root / 'ca.crt'),
                '-days', '1', '-subj', '/CN=Rio QA bootstrap test',
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            # Only the parsed certificate may enter the installed trust store.
            with (root / 'ca.crt').open('a') as certificate:
                certificate.write('\n-----BEGIN PRIVATE KEY-----\nsynthetic-invalid-key\n-----END PRIVATE KEY-----\n')
            (root / 'bootstrap.json').write_text(json.dumps({'claims': ['payments.example.test']}))
            check = '''
import json,os,pathlib,socket,subprocess
assert os.getuid() == 1000
assert socket.gethostbyname('payments.example.test') == '127.0.0.1'
certificate = pathlib.Path('/usr/local/share/ca-certificates/rio-run.crt')
assert 'PRIVATE KEY' not in certificate.read_text()
subprocess.run(['openssl','verify','-CAfile','/etc/ssl/certs/ca-certificates.crt',str(certificate)],check=True,stdout=subprocess.DEVNULL)
print(json.dumps({'uid':os.getuid(),'claims':'passed','ca':'passed'}))
'''
            name = root.name
            try:
                result = subprocess.run([
                    'docker', 'run', '--rm', '--name', name, '--network', 'none',
                    '--mount', f'type=bind,src={root / "bootstrap.json"},dst=/run/rio/bootstrap.json,readonly',
                    '--mount', f'type=bind,src={root / "ca.crt"},dst=/run/rio/ca.crt,readonly',
                    image, 'python3', '-c', check,
                ], capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), {'uid': 1000, 'claims': 'passed', 'ca': 'passed'})
            finally:
                subprocess.run(['docker', 'rm', '--force', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)


if __name__ == '__main__':
    unittest.main()
