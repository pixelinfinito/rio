import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
import documentation as docs
import documentation_schemas as schemas
spec=importlib.util.spec_from_file_location('publisher',ROOT/'scripts/publish-wiki.py')
publisher=importlib.util.module_from_spec(spec);spec.loader.exec_module(publisher)

class ContentTests(unittest.TestCase):
    def test_real_manifest_and_generated_sources(self):
        manifest=docs.read_manifest()
        self.assertEqual(docs.validate(manifest),[])
        docs.generate(manifest,check=True)
        schemas.generate(check=True)

    def test_duplicate_missing_locale_and_unknown_relationship_fail(self):
        m=copy.deepcopy(docs.read_manifest());m['topics'].append(copy.deepcopy(m['topics'][0]))
        m['topics'][0]['pages'].pop('pt-BR');m['topics'][0]['related'].append('not-a-topic')
        errors='\n'.join(docs.validate(m,require_pages=False))
        for term in ['duplicate topic','missing locale','missing related']:self.assertIn(term,errors)

    def test_unmapped_command_fails(self):
        m=copy.deepcopy(docs.read_manifest())
        for t in m['topics']:t['commands']=[c for c in t.get('commands',[]) if c!='rio qa seed export']
        self.assertIn('undocumented command: rio qa seed export',docs.validate(m,require_pages=False))

    def test_translation_and_source_review_freshness(self):
        m=copy.deepcopy(docs.read_manifest());m['topics'][0]['translation_review']['en']='old';m['topics'][0]['source_review']='old'
        errors='\n'.join(docs.validate(m));self.assertIn('stale translation',errors);self.assertIn('source review is stale',errors)

    def test_link_validation_handles_portuguese_and_duplicate_anchors(self):
        files={'PT.md':'# Pré-requisitos\n# Pré-requisitos\n[ok](PT#pré-requisitos-1)\n','EN.md':'[pt](PT#pré-requisitos)\n'}
        self.assertEqual(docs.links_errors(files),[])
        files['EN.md']+='[broken](PT#missing)\n[image](assets/missing.png)'
        self.assertEqual(len(docs.links_errors(files)),2)

    def test_render_is_deterministic_and_switches_stay_on_topic(self):
        m=docs.read_manifest()
        with tempfile.TemporaryDirectory() as a,tempfile.TemporaryDirectory() as b:
            docs.render(m,a);docs.render(m,b)
            left={str(p.relative_to(a)):p.read_bytes() for p in Path(a).rglob('*') if p.is_file()}
            right={str(p.relative_to(b)):p.read_bytes() for p in Path(b).rglob('*') if p.is_file()}
            self.assertEqual(left,right)
            self.assertIn(b'[Portugu\xc3\xaas (Brasil)](PT-BR-Profiles)',left['EN-Profiles.md'])
            self.assertIn(b'raw.githubusercontent.com/wiki/pixelinfinito/rio/assets/',left['EN-Tui.md'])
            self.assertEqual(left['Home.md'],left['EN-Start.md'])
            for page in ['Home.md','PT-BR-Start.md']:
                for term in [b'review-02-findings.png',b'review-00-start.png',b'rio review --staged',b'rio review --base origin/main',b'rio review --pr 123']:
                    self.assertIn(term,left[page])
            self.assertNotIn(b'On this page:',left['Home.md'])
            self.assertIn(b'**English**',left['_Sidebar.md'])
            for target in ['EN-Installation','EN-Review','PT-BR-Installation','PT-BR-Review']:
                self.assertIn(target.encode(),left['_Sidebar.md'])
            self.assertIn(b'<details>',left['EN-Review.md'])
            self.assertIn(b'config.toml',left['EN-Reference.md'])
            self.assertIn(b'rio qa seed export',left['EN-Reference.md'])


    def test_missing_assets_captions_flags_and_stale_capture_fail(self):
        from unittest.mock import patch
        original=Path.read_text
        def edited(path,*args,**kwargs):
            text=original(path,*args,**kwargs)
            if path.name=='captures.json':
                value=json.loads(text);value['captures'][0]['hashes']['png']='stale'
                source=next(iter(value['captures'][0]['sources']))
                value['captures'][0]['sources'][source]='stale'
                return json.dumps(value)
            if str(path).endswith('pt-BR/review.md'):
                return text.replace('--staged','REMOVED').replace('![','[')
            return text
        with patch.object(Path,'read_text',edited):
            errors='\n'.join(docs.validate(docs.read_manifest()))
        for term in ['missing/modified png','stale capture source','missing translated screenshot alt','undocumented rio review --staged']:
            self.assertIn(term,errors)

    def test_sidebar_requires_localized_labels_and_valid_targets(self):
        m=copy.deepcopy(docs.read_manifest())
        m['sidebar'][0]['labels'].pop('pt-BR')
        m['sidebar'][0]['topic']='absent'
        errors=docs.validate(m,require_pages=False)
        self.assertIn('missing localized sidebar label',errors)
        self.assertIn('unknown sidebar topic',errors)

    def test_command_specific_descriptions_do_not_mix_different_operations(self):
        tables=docs.command_tables(docs.read_manifest())
        self.assertIn('GitHub pull request number;',tables['docs/wiki/en/review.md'])
        self.assertNotIn('incident PR URL',tables['docs/wiki/en/review.md'])
        self.assertIn('Journey name to inspect;',tables['docs/wiki/en/qa.md'])
        self.assertIn('Cloudflare resource-name prefix',tables['docs/wiki/en/hosting.md'])
        self.assertNotIn('depending on command',''.join(tables.values()))

    def test_profiles_and_qa_examples_validate(self):
        import re,yaml,jsonschema
        binary=ROOT/'target/debug'/('rio.exe' if os.name=='nt' else 'rio')
        self.assertTrue(binary.is_file(),'build rio-cli before documentation example checks')
        schemas_by_name={name:json.loads((ROOT/'schemas'/name).read_text()) for name in ['profile-v1.json','qa-config-v1.json','journey-v1.json']}
        count=0
        with tempfile.TemporaryDirectory() as tmp:
            env=os.environ|{'RIO_CONFIG_DIR':str(Path(tmp)/'config'),'NO_COLOR':'1'}
            for path in (ROOT/'docs/wiki').glob('*/*.md'):
                for block in re.findall(r'```yaml\n(.*?)```',path.read_text(),re.S):
                    value=yaml.safe_load(block)
                    name='qa-config-v1.json' if 'app' in value else 'journey-v1.json' if 'persona' in value else 'profile-v1.json'
                    jsonschema.Draft202012Validator(schemas_by_name[name]).validate(value)
                    if name=='profile-v1.json':
                        p=Path(tmp)/'example.yaml';p.write_text(block)
                        result=subprocess.run([str(binary),'profile','validate',str(p)],cwd=tmp,env=env,capture_output=True,text=True)
                        self.assertEqual(result.returncode,0,f'{path}: {result.stderr}')
                    count+=1
        self.assertGreaterEqual(count,10)

    @unittest.skipIf(os.name=='nt','PTY check runs on Unix')
    def test_tty_matches_pipe_without_ansi(self):
        import pty,termios
        binary=ROOT/'target/debug/rio'
        expected=subprocess.check_output([str(binary),'docs','review'])
        master,slave=pty.openpty()
        try:
            attrs=termios.tcgetattr(slave);attrs[1] &= ~termios.OPOST;termios.tcsetattr(slave,termios.TCSANOW,attrs)
            process=subprocess.Popen([str(binary),'docs','review'],stdout=slave,stderr=subprocess.PIPE)
            os.close(slave);slave=None
            actual=b''
            while True:
                try: chunk=os.read(master,65536)
                except OSError: break
                if not chunk:break
                actual+=chunk
            self.assertEqual(process.wait(timeout=10),0)
            self.assertEqual(process.stderr.read(),b'');process.stderr.close()
            self.assertEqual(actual,expected)
        finally:
            os.close(master)
            if slave is not None:os.close(slave)

    def test_safe_guide_commands_in_disposable_repository(self):
        binary=ROOT/'target/debug'/('rio.exe' if os.name=='nt' else 'rio')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);env=os.environ|{'RIO_CONFIG_DIR':str(root/'config'),'NO_COLOR':'1','RIO_TUI':'0'}
            def run(*args):return subprocess.run(args,cwd=root,env=env,capture_output=True,text=True)
            self.assertEqual(run('git','init').returncode,0)
            run('git','config','user.name','Documentation fixture');run('git','config','user.email','docs@example.invalid')
            (root/'README.md').write_text('Synthetic documentation fixture\n')
            run('git','add','README.md');self.assertEqual(run('git','commit','-m','fixture').returncode,0)
            clean=run(str(binary),'review','--offline','--no-tui','--format','json')
            self.assertEqual(clean.returncode,0,clean.stderr)
            self.assertEqual(json.loads(clean.stdout)['status'],'no_changes')
            (root/'README.md').write_text('Synthetic documentation fixture, changed\n')
            report=run(str(binary),'review','--offline','--no-tui','--format','json')
            self.assertIn(report.returncode,[0,1,2],report.stderr);self.assertIn('checks',json.loads(report.stdout))
            doctor=run(str(binary),'doctor');self.assertIn(doctor.returncode,[0,1],doctor.stderr)
            shutil.copytree(ROOT/'tests/fixtures/qa-sample/.rio',root/'.rio',dirs_exist_ok=True)
            for args in [('qa','validate'),('qa','list'),('qa','show')]:
                result=run(str(binary),*args);self.assertEqual(result.returncode,0,result.stderr)

class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.remote=self.root/'wiki.git';self.work=self.root/'seed'
        self.cmd('git','init','--bare',str(self.remote));self.cmd('git','clone',str(self.remote),str(self.work))
        self.cmd('git','config','user.name','test',cwd=self.work);self.cmd('git','config','user.email','test@example.invalid',cwd=self.work)
        (self.work/'Home.md').write_text('# Placeholder\n');(self.work/'Manual.md').write_text('# Keep me\n')
        self.commit('initial');self.stage=self.root/'stage';self.stage.mkdir();self.staging({'Home.md':'# Rio\n','EN-Start.md':'# Start\n'})
    def tearDown(self):self.tmp.cleanup()
    def cmd(self,*args,cwd=None):return subprocess.check_output(args,cwd=cwd or self.root,stderr=subprocess.DEVNULL,text=True).strip()
    def commit(self,message):
        self.cmd('git','add','--all',cwd=self.work);self.cmd('git','commit','-m',message,cwd=self.work);self.cmd('git','push','origin','HEAD',cwd=self.work)
    def staging(self,files):
        for p in self.stage.glob('*'):p.unlink()
        for path,content in files.items():(self.stage/path).write_text(content)
        (self.stage/publisher.MANIFEST).write_text(json.dumps({'schema_version':1,'source_commit':'a'*40,'docs_revision':docs.digest(str(files)),'files':{p:docs.digest(c) for p,c in files.items()}}))
    def test_first_adoption_idempotency_and_unrelated_files(self):
        with self.assertRaisesRegex(ValueError,'Unmanaged'):publisher.publish(self.stage,str(self.remote))
        result=publisher.publish(self.stage,str(self.remote),['Home.md']);self.assertTrue(result['changed'])
        self.assertFalse(publisher.publish(self.stage,str(self.remote))['changed'])
        self.cmd('git','pull',cwd=self.work);self.assertEqual((self.work/'Manual.md').read_text(),'# Keep me\n')
    def test_managed_edit_is_not_overwritten(self):
        publisher.publish(self.stage,str(self.remote),['Home.md']);self.cmd('git','pull',cwd=self.work)
        (self.work/'Home.md').write_text('# Someone edited this\n');self.commit('manual change')
        with self.assertRaisesRegex(ValueError,'external edit'):publisher.publish(self.stage,str(self.remote))
    def test_owned_deletion_and_rollback_by_republishing(self):
        publisher.publish(self.stage,str(self.remote),['Home.md'])
        self.staging({'Home.md':'# Next\n'});publisher.publish(self.stage,str(self.remote))
        self.cmd('git','pull',cwd=self.work);self.assertFalse((self.work/'EN-Start.md').exists())
        self.staging({'Home.md':'# Rio\n','EN-Start.md':'# Start\n'});publisher.publish(self.stage,str(self.remote))
        self.cmd('git','pull',cwd=self.work);self.assertTrue((self.work/'EN-Start.md').exists())
    def test_tampering_and_unsafe_paths_fail_before_network(self):
        (self.stage/'Home.md').write_text('changed')
        with self.assertRaisesRegex(ValueError,'missing/changed'):publisher.publish(self.stage,'unused')
        for path in ['../outside','/absolute','.git/config','.GIT/config','a/../../outside','C:\\outside']:
            with self.assertRaises(ValueError):publisher.safe(path)
    @unittest.skipIf(os.name=='nt','Symlink test requires Unix')
    def test_owned_deletion_rejects_symlink_parent(self):
        outside=self.root/'outside';outside.mkdir();(outside/'kept.md').write_text('keep')
        (self.work/'linked').symlink_to(outside,target_is_directory=True)
        (self.work/publisher.MANIFEST).write_text(json.dumps({'schema_version':1,'files':{'linked/kept.md':docs.digest('keep')}}))
        self.commit('malicious ownership')
        with self.assertRaisesRegex(ValueError,'external edit'):publisher.publish(self.stage,str(self.remote),['Home.md'])
        self.assertEqual((outside/'kept.md').read_text(),'keep')

    def test_concurrent_remote_change_aborts(self):
        original=publisher.git;triggered=False
        def racing(cwd,*args):
            nonlocal triggered
            if args[0]=='ls-remote' and not triggered:
                triggered=True;(self.work/'Manual.md').write_text('# Concurrent edit\n');self.commit('concurrent')
            return original(cwd,*args)
        publisher.git=racing
        try:
            with self.assertRaisesRegex(ValueError,'concurrently'):publisher.publish(self.stage,str(self.remote),['Home.md'])
        finally:publisher.git=original
        self.assertEqual((self.work/'Home.md').read_text(),'# Placeholder\n')

if __name__=='__main__':unittest.main()
