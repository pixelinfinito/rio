import importlib.util
import io
import json
import os
from pathlib import Path
import secrets
import socket
import tempfile
import unittest
from unittest.mock import patch

from pod import Pod, PodError, docker
from test_pod import archive_files

source = importlib.util.spec_from_file_location('subscription', Path(__file__).with_name('subscription-entrypoint.py'))
subscription = importlib.util.module_from_spec(source)
source.loader.exec_module(subscription)


class AuthTests(unittest.TestCase):
    def test_subscription_bootstrap_excludes_unknown_fields_and_provider_keys(self):
        auth = {'tokens': {'access_token': 'synthetic-subscription', 'extra': 'omit'}, 'unknown': 'omit'}
        self.assertEqual(set(subscription.subscription(auth)['tokens']), {'access_token'})
        self.assertNotIn('unknown', subscription.subscription(auth))
        for value in ({}, {**auth, 'OPENAI_API_KEY': 'provider-key'}, {**auth, 'auth_mode': 'apikey'}):
            with self.assertRaises(ValueError):
                subscription.subscription(value)

    def test_hosted_rejects_both_local_auth_paths_before_starting_docker(self):
        for option in ({'subscription_file': '/host/auth'}, {'model_socket': '/host/model'}):
            with patch('pod.Firewall') as firewall, self.assertRaises(PodError):
                Pod('a' * 16, qa_image='unused', app_image='unused', hosted=True, **option)
            firewall.assert_not_called()


@unittest.skipUnless(os.environ.get('RIO_TEST_QA_DOCKER') == '1', 'requires Docker and host firewall control')
class DockerAuthTests(unittest.TestCase):
    def test_subscription_is_readonly_controller_only_and_bootstrap_drops_privileges(self):
        image = os.environ.get('RIO_QA_IMAGE', 'rio-qa:local')
        with tempfile.TemporaryDirectory() as temporary:
            auth = Path(temporary) / 'auth.json'
            original = json.dumps({'auth_mode': 'chatgpt', 'tokens': {'access_token': 'synthetic-subscription'}})
            auth.write_text(original)
            auth.chmod(0o600)
            # No external auth request is needed to inspect the bootstrap.
            with patch('pod.pin_endpoints', return_value=[]):
                pod = Pod(secrets.token_hex(8), qa_image=image, app_image=image, hosted=False, subscription_file=auth)
            try:
                pod.create(snapshot=archive_files({'app.js': b'setInterval(()=>{},1000)'}), app_command=['node', 'app.js'], app_port=8080, assets={},
                           controller_command=['node', '-e', 'setInterval(()=>{},1000)'])
                pod.start()
                command = "import fs from 'node:fs';const p=process.env.RIO_QA_SUBSCRIPTION_FILE;let readonly=false;try{fs.writeFileSync('/run/rio/subscription.json','overwrite')}catch{readonly=true};console.log(JSON.stringify({uid:process.getuid(),readonly,auth:JSON.parse(fs.readFileSync(p)).auth_mode,caps:fs.readFileSync('/proc/self/status','utf8').match(/CapEff:\\s+(\\w+)/)[1]}))"
                # The test awaits bootstrap completion inside the container.
                command = "for(let i=0;i<50;i++){try{await import('node:fs/promises').then(fs=>fs.access('/run/rio/auth/auth.json'));break}catch{await new Promise(r=>setTimeout(r,100))}};" + command
                output = docker('exec', '--user', '1000:1000', pod.containers['controller'], 'node', '--input-type=module', '-e', command, check=False)
                self.assertEqual(output.returncode, 0, output.stderr.decode() + docker('logs', pod.containers['controller'], check=False).stderr.decode())
                result = json.loads(output.stdout)
                self.assertEqual(result, {'uid': 1000, 'readonly': True, 'auth': 'chatgpt', 'caps': '0000000000000000'})
                # Confirm the actual controller process dropped privilege too.
                actual = docker('exec', pod.containers['controller'], 'node', '-e', "const fs=require('fs');const pid=fs.readFileSync('/proc/1/task/1/children','utf8').trim().split(/\\s+/)[0];const s=fs.readFileSync('/proc/'+pid+'/status','utf8');console.log(JSON.stringify({uid:s.match(/Uid:\\s+(\\d+)/)[1],caps:s.match(/CapEff:\\s+(\\w+)/)[1]}))")
                self.assertEqual(json.loads(actual.stdout), {'uid': '1000', 'caps': '0000000000000000'})
                self.assertEqual(auth.read_text(), original)
                for role in ('app', 'browser', 'controller'):
                    info = json.loads(docker('inspect', pod.containers[role]).stdout)[0]
                    mounts = [mount for mount in info['Mounts'] if mount['Type'] == 'bind']
                    self.assertEqual(len(mounts), 1 if role == 'controller' else 0)
                    if mounts:
                        self.assertFalse(mounts[0]['RW'])
                    self.assertNotIn('synthetic-subscription', json.dumps(info['Config']['Env']))
            finally:
                pod.close()

    def test_host_relay_socket_and_capability_never_expose_a_provider_key_to_containers(self):
        image = os.environ.get('RIO_QA_IMAGE', 'rio-qa:local')
        with tempfile.TemporaryDirectory() as temporary, socket.socket(socket.AF_UNIX) as relay:
            path = Path(temporary) / 'model.sock'
            relay.bind(str(path)); relay.listen(1); path.chmod(0o666)
            pod = Pod(secrets.token_hex(8), qa_image=image, app_image=image, hosted=False, model_socket=path)
            try:
                pod.create(snapshot=archive_files({'app.js': b'setInterval(()=>{},1000)'}), app_command=['node', 'app.js'], app_port=8080, assets={},
                           controller_command=['node', '-e', 'setInterval(()=>{},1000)'])
                pod.start()
                for role in ('app', 'browser', 'controller'):
                    info = json.loads(docker('inspect', pod.containers[role]).stdout)[0]
                    mounts = [mount for mount in info['Mounts'] if mount['Type'] == 'bind']
                    self.assertEqual(len(mounts), 1 if role == 'controller' else 0)
                    self.assertFalse(any('API_KEY=' in value for value in info['Config']['Env']))
                    output = docker('exec', pod.containers[role], 'node', '-e', "const s=require('net').connect('/run/rio/model.sock');s.on('connect',()=>{console.log('connected');s.destroy()});s.on('error',()=>console.log('blocked'))")
                    self.assertEqual(output.stdout.strip(), b'connected' if role == 'controller' else b'blocked')
            finally:
                pod.close()


if __name__ == '__main__':
    unittest.main()
