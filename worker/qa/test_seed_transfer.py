"""Real app/controller seed transfer with the pod firewall active."""
import json
import os
from pathlib import Path
import secrets
import tempfile
import time
import unittest

from pod import Pod, docker
from test_pod import archive_files


@unittest.skipUnless(os.environ.get('RIO_TEST_QA_DOCKER') == '1', 'requires Docker and host firewall control')
class SeedTransferTests(unittest.TestCase):
    def test_cache_reuse_is_controller_only_and_precedes_rotated_credentials(self):
        root = Path(__file__).resolve().parents[2]
        image = os.environ.get('RIO_QA_IMAGE', 'rio-qa:local')
        fingerprint = {'version': 2, 'fingerprint': 'a' * 64, 'datastores': {'accounts': 'sqlite'}}
        controller = """
import {LocalSeedBackend,SeedStore} from '/opt/rio-qa/src/seed-store.mjs';
import {SeedTransferClient} from '/opt/rio-qa/src/seed-transfer.mjs';
import {access,writeFile} from 'node:fs/promises';
const store=new SeedStore({backend:await LocalSeedBackend.create('/tmp/qa-seeds')});
const pump=await new SeedTransferClient({baseURL:process.env.RIO_QA_APP_CONTROL,store,
 fingerprint:FINGERPRINT,names:['accounts']}).start();
try {
 for(let i=0;i<300;i++) {
   if(pump.failure)throw pump.failure;
   try{await access('/tmp/stop-pump');break}catch{}
   await new Promise(r=>setTimeout(r,100));
 }
} finally {await pump.close()}
await writeFile('/tmp/pump-closed','closed');
setInterval(()=>{},1000);
""".replace('FINGERPRINT', json.dumps(fingerprint))
        app = b"""const {execFileSync}=require('node:child_process');
require('node:http').createServer((req,res)=>{
if(req.url==='/mutate')execFileSync('sqlite3',['data.db',\"INSERT INTO users VALUES ('journey-record','changed')\"]);
res.end(execFileSync('sqlite3',['data.db','SELECT name,password FROM users ORDER BY name']));
}).listen(4173,'0.0.0.0');"""
        contract = {'app': {'packaging': 'vendored', 'start': 'node app.cjs', 'url': 'http://app:4173',
                            'env': {'DB': 'data.db'}, 'ready': {'path': '/', 'status': 200, 'timeout': '10s'}},
                    'personas': [{'name': 'shopper', 'password_env': 'QA_PASSWORD'}]}
        seed = {'datastores': [{'name': 'accounts', 'kind': 'sqlite', 'connection_env': 'DB'}],
                'steps': [{'command': 'test ! -e fail-if-built && sqlite3 data.db "CREATE TABLE users(name,password); INSERT INTO users VALUES (\'shopper\',NULL);"', 'applies_to': ['accounts']}],
                'users': [{'persona': 'shopper', 'apply': 'python3 -c "import os,sqlite3; d=sqlite3.connect(\'data.db\');d.execute(\'UPDATE users SET password=?\',(os.environ[\'QA_PASSWORD\'],));d.commit()"'}], 'paths': []}
        with tempfile.TemporaryDirectory() as cache:
            for index, password in enumerate(('synthetic-first', 'synthetic-rotated')):
                pod = Pod(secrets.token_hex(8), qa_image=image, app_image=image)
                def node(role, script):
                    return docker('exec', pod.containers[role], 'node', '--input-type=module', '-e', script).stdout.decode().strip()
                try:
                    files = {'app.cjs': app}
                    if index:
                        files['fail-if-built'] = b'cache hit must bypass seed commands'
                    pod.create(snapshot=archive_files(files), app_command=['node', 'app.cjs'], app_port=4173,
                               assets={}, controller_command=['node', '--input-type=module', '-e', controller],
                               app_runtime={'contract': contract, 'seed': seed, 'seed_fingerprint': fingerprint,
                                            'seed_transfer': True, 'stage_timeout_ms': 20000},
                               app_credentials={'QA_PASSWORD': password}, app_hooks=root / 'crates/rio-qa/controller/src')
                    if index:
                        docker('cp', '-a', str(Path(cache) / 'qa-seeds'), pod.containers['controller'] + ':/tmp/')
                    pod.start()
                    for _ in range(100):
                        status = node('controller', "try{console.log((await fetch(process.env.RIO_QA_APP_CONTROL+'/status')).status)}catch{console.log(0)}")
                        if status == '200':
                            break
                        time.sleep(0.1)
                    self.assertEqual(status, '200', docker('logs', pod.containers['controller']).stderr.decode())
                    self.assertEqual(node('browser', "console.log(await(await fetch('http://app:4173')).text())"), 'shopper|' + password)
                    node('browser', "await fetch('http://app:4173/mutate')")
                    self.assertEqual(node('controller', "console.log((await fetch(process.env.RIO_QA_APP_CONTROL+'/reset',{method:'POST'})).status)"), '200')
                    self.assertEqual(node('browser', "console.log(await(await fetch('http://app:4173')).text())"), 'shopper|' + password)
                    self.assertEqual(node('app', "import fs from 'node:fs';console.log(fs.existsSync('/tmp/qa-seeds'))"), 'false')
                    docker('exec', pod.containers['controller'], 'touch', '/tmp/stop-pump')
                    for _ in range(50):
                        if node('controller', "import fs from 'node:fs';console.log(fs.existsSync('/tmp/pump-closed'))") == 'true':
                            break
                        time.sleep(0.1)
                    restored = node('controller', "import {LocalSeedBackend,SeedStore} from '/opt/rio-qa/src/seed-store.mjs';import{execFileSync}from'node:child_process';const s=new SeedStore({backend:await LocalSeedBackend.create('/tmp/qa-seeds')});await s.restore('/tmp/inspect',{fingerprint:" + json.dumps(fingerprint) + "});console.log(execFileSync('sqlite3',['/tmp/inspect/accounts.archive','SELECT name,password FROM users']).toString());")
                    self.assertEqual(restored, 'shopper|', 'persona values must never reach persistent snapshots')
                    if not index:
                        docker('cp', '-a', pod.containers['controller'] + ':/tmp/qa-seeds', cache)
                finally:
                    pod.close()


if __name__ == '__main__':
    unittest.main()
