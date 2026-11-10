"""Exercise startup and chain restoration against the provisioned sample app."""
import io
import json
import os
from pathlib import Path
import secrets
import tarfile
import time
import unittest

from pod import Pod, docker
from test_pod import archive_files


@unittest.skipUnless(os.environ.get('RIO_TEST_QA_DOCKER') == '1', 'requires Docker and host firewall control')
class AppRuntimeTests(unittest.TestCase):
    def test_seed_capture_credentials_readiness_and_chain_reset(self):
        root = Path(__file__).resolve().parents[2]
        fixture = root / 'tests/fixtures/qa-sample'
        files = {}
        for directory, children, names in os.walk(fixture):
            children[:] = [name for name in children if name not in {'node_modules', 'dist', '.git', 'data', 'test-results', '.playwright-mcp'}]
            for name in names:
                path = Path(directory) / name
                if path.is_file() and not path.is_symlink():
                    files[path.relative_to(fixture).as_posix()] = path.read_bytes()
        contract = {
            'app': {'packaging': 'image', 'dockerfile': 'Dockerfile.qa',
                    'start': 'npm run build && node server.mjs',
                    'url': 'http://app:4173', 'ready': {'path': '/api/health', 'status': 200, 'timeout': '20s'},
                    'env': {'DATABASE_URL': 'data/shop.sqlite'},
                    'seed': "printf hook-ran > data/hook.txt"},
            'personas': [{'name': 'shopper', 'username_env': 'QA_SHOPPER_USERNAME', 'password_env': 'QA_SHOPPER_PASSWORD'}, {'name': 'registrant', 'username_env': 'QA_REGISTRANT_USERNAME', 'password_env': 'QA_REGISTRANT_PASSWORD'}],
        }
        seed = {'datastores': [{'name': 'shop', 'kind': 'sqlite', 'connection_env': 'DATABASE_URL'}],
                'steps': [{'file': 'schema.sql', 'applies_to': ['shop']}],
                'users': [{'persona': 'shopper', 'apply': 'node scripts/seed.mjs shopper'}], 'paths': []}
        fixtures = {'files': [{'name': 'contacts', 'generate': {'kind': 'csv', 'rows': 20}}], 'services': [
            {'name': 'payments', 'kind': 'http-mock', 'env': {'PAYMENTS_API_BASE': '{{url}}'},
             'recordings': 'recordings/payments', 'behaviors': ['approve', 'decline'], 'default_behavior': 'approve',
             'claims': ['payments.example.test']},
            {'name': 'mail', 'kind': 'smtp-capture', 'env': {'SMTP_HOST': '127.0.0.1', 'SMTP_PORT': '{{port}}'}}],
            'capture': {'mail': True}}
        credentials = {'QA_SHOPPER_USERNAME': 'shopper@example.test', 'QA_SHOPPER_PASSWORD': 'synthetic-shopper-123', 'QA_REGISTRANT_USERNAME': 'repeat@example.test', 'QA_REGISTRANT_PASSWORD': 'synthetic-registration'}
        pod = Pod(secrets.token_hex(8), qa_image=os.environ.get('RIO_QA_IMAGE', 'rio-qa:0.1.0'), app_image=os.environ.get('RIO_QA_SAMPLE_IMAGE', 'rio-qa-sample:local'))
        def node(role, script):
            return docker('exec', '--user', '1000:1000', pod.containers[role], 'node', '--input-type=module', '-e', script).stdout.decode().strip()
        def copied(path):
            data = docker('cp', pod.containers['app'] + ':' + path, '-').stdout
            with tarfile.open(fileobj=io.BytesIO(data)) as archive:
                member = next(member for member in archive if member.isreg())
                return archive.extractfile(member).read().decode()
        try:
            pod.create(snapshot=archive_files(files), app_command=['node', 'server.mjs'], app_port=4173,
                       assets={}, controller_command=['node', '-e', 'setInterval(()=>{},1000)'],
                       app_runtime={'contract': contract, 'seed': seed, 'fixtures': fixtures, 'stage_timeout_ms': 10000},
                       app_credentials=credentials, app_hooks=root / 'crates/rio-qa/controller/src')
            pod.start()
            control = f'http://{pod.addresses["app"]}:{pod.control_port}'
            for _ in range(60):
                status = node('controller', f"try{{console.log((await fetch('{control}/status')).status)}}catch{{console.log(0)}}")
                if status == '200': break
                state = json.loads(docker('inspect', '--format', '{{json .State}}', pod.containers['app']).stdout)
                if not state['Running']:
                    bootstrap = docker('logs', pod.containers['app'], check=False)
                    self.fail((bootstrap.stdout + bootstrap.stderr).decode())
                time.sleep(0.25)
            self.assertEqual(status, '200')
            generated = node('controller', f"console.log(await(await fetch('{control}/fixtures/files/contacts')).text())")
            self.assertEqual(len(generated.splitlines()), 21)
            self.assertIn('person20@example.test', generated)
            script = """
const url='http://app:4173';
let r=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'shopper@example.test',password:'synthetic-shopper-123'})});
if(r.status!==200)throw Error('persona credentials not applied');
const cookie=r.headers.get('set-cookie').split(';')[0];
r=await fetch(url+'/api/cart',{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({product_id:1})});
if(r.status!==200)throw Error('cart failed');
r=await fetch(url+'/api/checkout',{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({email:'shopper@example.test',address:'10 Sample Street'})});
const order=await r.json();if(r.status!==201||!order.confirmation)throw Error('checkout failed '+r.status);
console.log(order.order);
"""
            self.assertEqual(node('browser', script), '1')
            # A hard-coded HTTPS call trusts only the run-generated CA.
            self.assertEqual(node('app', "console.log((await fetch('https://payments.example.test/v1/charges',{method:'POST',body:'{}'})).status)"), '200')
            browser_tls = "import {openBrowser} from '/opt/rio-qa/src/browser.mjs';const b=await openBrowser({endpoint:process.env.RIO_QA_BROWSER,viewport:{width:390,height:844,mobile:true,touch:true}});try{const r=await b.page.goto('https://payments.example.test/v1/charges');console.log(r.status())}finally{await b.close()}"
            self.assertEqual(node('controller', browser_tls), '501', 'browser reaches claimed HTTPS without disabling all certificate checks')
            runtime_uid = "import{readdirSync,readFileSync}from'node:fs';const p=readdirSync('/proc').filter(x=>/^[0-9]+$/.test(x)).find(x=>{try{return readFileSync('/proc/'+x+'/cmdline','utf8').startsWith('node\\0/opt/rio-qa-app/app-entrypoint.mjs')}catch{return false}});console.log(p&&/^Uid:\\s+1000\\s+1000/m.test(readFileSync('/proc/'+p+'/status','utf8')))"
            self.assertEqual(node('app', runtime_uid), 'true', 'application hooks must run after dropping root')
            self.assertEqual(node('app', "try{await fetch('https://api.undoubled.example',{signal:AbortSignal.timeout(2000)});console.log('escaped')}catch{console.log('blocked')}"), 'blocked')
            dependency_events = json.loads(node('controller', f"console.log(JSON.stringify(await(await fetch('{control}/fixtures/events')).json()))"))
            self.assertTrue(any(event.get('host') == 'api.undoubled.example' and event['kind'] == 'blocked_egress' for event in dependency_events['events']))
            for behavior, expected in [('decline', '402'), ('approve', '200')]:
                self.assertEqual(node('controller', f"console.log((await fetch('{control}/fixtures/behavior',{{method:'POST',headers:{{'content-type':'application/json'}},body:JSON.stringify({{service:'payments',behavior:'{behavior}'}})}})).status)"), '200')
                self.assertEqual(node('app', "console.log((await fetch('https://payments.example.test/v1/charges',{method:'POST',body:'{}'})).status)"), expected)
            reset = node('controller', f"const r=await fetch('{control}/reset',{{method:'POST'}});console.log(r.status);")
            self.assertEqual(reset, '200')
            self.assertEqual(node('controller', f"console.log(await(await fetch('{control}/fixtures/files/contacts')).text())"), generated)
            self.assertEqual(node('browser', script), '1', 'fresh chain must restore the original order sequence')
            self.assertEqual(copied('/work/repo/data/hook.txt'), 'hook-ran')
            stages = copied('/tmp/rio-qa-stages.jsonl')
            self.assertNotIn(credentials['QA_SHOPPER_PASSWORD'], stages)
            self.assertNotIn(credentials['QA_SHOPPER_USERNAME'], stages)
            self.assertIn('"action":"built"', stages)
            self.assertIn('"action":"restored"', stages)
            # The archived seed must precede credential application.
            archive_password = node('app', "import {readdirSync} from 'node:fs';import {DatabaseSync}from'node:sqlite';const dir=readdirSync('/tmp').find(x=>x.startsWith('rio-qa-seed-'));const db=new DatabaseSync('/tmp/'+dir+'/shop.archive');console.log(db.prepare(\"SELECT password_hash FROM users WHERE persona='shopper'\").get().password_hash);db.close();")
            self.assertEqual(archive_password, 'null')
            # A record-creating chain head restores once in every matrix cell.
            for viewport in ('mobile', 'desktop'):
                for scheme in ('light', 'dark'):
                    self.assertEqual(node('controller', f"console.log((await fetch('{control}/reset',{{method:'POST'}})).status)"), '200')
                    registration = "console.log((await fetch('http://app:4173/api/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'repeat@example.test',password:'synthetic-registration'})})).status)"
                    self.assertEqual(node('browser', registration), '201', f'{viewport}/{scheme} must begin without the previous account')
                    capture = node('controller', f"console.log(JSON.stringify(await(await fetch('{control}/fixtures/read',{{method:'POST',headers:{{'content-type':'application/json'}},body:JSON.stringify({{kind:'mail',name:'registrant'}})}})).json()))")
                    messages = json.loads(capture)['messages']
                    self.assertEqual(len(messages), 1)
                    self.assertIn('token=', messages[0]['links'][0])
                    token = messages[0]['links'][0].split('token=')[1]
                    verification = f"console.log((await fetch('http://app:4173/api/verify',{{method:'POST',headers:{{'content-type':'application/json'}},body:JSON.stringify({{token:{json.dumps(token)}}})}})).status)"
                    self.assertEqual(node('browser', verification), '200')


        finally:
            pod.close()

    def test_missing_datastore_server_reports_binary_and_app_image(self):
        root = Path(__file__).resolve().parents[2]
        image = os.environ.get('RIO_QA_IMAGE', 'rio-qa:0.1.0')
        pod = Pod(secrets.token_hex(8), qa_image=image, app_image=image)
        try:
            pod.create(snapshot=archive_files({'app.js': b"throw Error('app must not start')"}), app_command=['node', 'app.js'], app_port=4173,
                       assets={}, controller_command=['node', '-e', 'setInterval(()=>{},1000)'], app_hooks=root / 'crates/rio-qa/controller/src',
                       app_runtime={'contract': {'app': {'packaging':'vendored','start':'node app.js','env':{'DB':'postgres://127.0.0.1/shop'},'url':'http://app:4173','ready':{'path':'/','status':200}},'personas':[]},
                                    'seed': {'datastores':[{'name':'shop','kind':'postgres','connection_env':'DB'}],'steps':[],'users':[],'paths':[]}})
            pod.start()
            for _ in range(50):
                state = json.loads(docker('inspect', '--format', '{{json .State}}', pod.containers['app']).stdout)
                if not state['Running']:
                    break
                time.sleep(0.1)
            data = docker('cp', pod.containers['app'] + ':/tmp/rio-qa-startup.json', '-').stdout
            with tarfile.open(fileobj=io.BytesIO(data)) as bundle:
                failure = json.load(bundle.extractfile(next(member for member in bundle if member.isreg())))
            self.assertEqual(failure['reason'], 'missing_tool')
            self.assertIn(failure['stage'], ('postgres', 'initdb'))
            self.assertEqual(failure['image'], image)
        finally:
            pod.close()


if __name__ == '__main__':
    unittest.main()
