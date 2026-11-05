import subprocess,os,time,json,pathlib,sys
case,side,checkout,node=sys.argv[1:]
out=pathlib.Path('/home/ubuntu/.t3/worktrees/rio/eval-run-vue-core/eval/runs')/f'vue-core-{case}-evidence'
env={**os.environ,'PATH':f'/tmp/node-v{node}-linux-x64/bin:/tmp/vue-eval-tools/node_modules/.bin:'+os.environ['PATH'],'PUPPETEER_SKIP_DOWNLOAD':'true','CI':'1'}
pkg='packages/compiler-sfc' if case=='12701' else 'packages/shared'
files=subprocess.check_output(['git','ls-tree','-r','--name-only','HEAD','--',pkg],cwd=checkout,text=True).splitlines();files=[str(pathlib.Path(checkout)/f) for f in files if f.rsplit('.',1)[-1] in ['ts','tsx','mts','cts','js','jsx','mjs','cjs']]
commands=[([str(pathlib.Path(checkout)/'node_modules/.bin/tsc'),'--noEmit','--pretty','false',*files],'typecheck-fallback'),([str(pathlib.Path(checkout)/'node_modules/.bin/vitest'),'run','--coverage','--coverage.reporter=lcov','--coverage.reportsDirectory=/tmp/vue-repro-coverage-'+case+'-'+side,*(['--coverage.all'] if case=='12701' else []),'--maxWorkers=2','--minWorkers=1'],'coverage-package-root')]
ledger=[]
for cmd,label in commands:
 start=time.monotonic();log=out/f'{side}-adapter-{label}.log'
 with log.open('w') as f:p=subprocess.run(cmd,cwd=str(pathlib.Path(checkout)/pkg),env=env,stdout=f,stderr=subprocess.STDOUT)
 ledger.append(dict(argv=cmd,cwd=str(pathlib.Path(checkout)/pkg),exit_code=p.returncode,wall_time_seconds=round(time.monotonic()-start,3),log=str(log),environment={'PATH':env['PATH'],'CI':'1','PUPPETEER_SKIP_DOWNLOAD':'true'}));print(case,side,label,p.returncode,flush=True)
 (out/f'{side}-adapter-reproduction.json').write_text(json.dumps(ledger,indent=2)+'\n')
