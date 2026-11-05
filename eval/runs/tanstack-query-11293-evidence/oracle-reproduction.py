import pathlib,json,os,subprocess,time,sys
side=sys.argv[1];out=pathlib.Path(__file__).resolve().parent/('oracle-'+side);out.mkdir(exist_ok=True);repo=pathlib.Path('/dev/shm/rio-tanstack-work/maintainer-'+side)
node='/dev/shm/rio-tanstack-tools/node-v24.16.0-linux-x64/bin/node';env={**os.environ,'PATH':str(pathlib.Path(node).parent)+':'+os.environ['PATH'],'COREPACK_HOME':'/dev/shm/rio-tanstack-tools/corepack-cache','NODE_DISABLE_COMPILE_CACHE':'1'};plan=json.loads((out.parent/'install-plan.json').read_text())[side]
commands=[('install-'+str(i),repo,a) for i,a in enumerate(plan)]
commands += [('types',repo,[node,'node_modules/typescript/lib/tsc.js','--noEmit','--pretty','false','-p','packages/query-core']),('eslint',repo/'packages/query-core',[node,str(repo/'node_modules/eslint/bin/eslint.js'),'--format','json','./src']),('coverage',repo/'packages/query-core',[node,str(repo/'node_modules/vitest/vitest.mjs'),'run','--coverage','--coverage.reporter=lcov','--coverage.reportsDirectory='+str(out/'coverage'),'--maxWorkers=2'])]
ledger=[]
for label,cwd,argv in commands:
 start=time.monotonic()
 with open(out/(label+'.stdout.log'),'wb') as so,open(out/(label+'.stderr.log'),'wb') as se:
  try:code=subprocess.run(argv,cwd=cwd,env=env,stdout=so,stderr=se,timeout=400).returncode
  except subprocess.TimeoutExpired:code=124
 ledger.append(dict(label=label,argv=argv,cwd=str(cwd),exit_code=code,wall_time_seconds=time.monotonic()-start));(out/'commands.json').write_text(json.dumps(ledger,indent=2)+'\n');print(side,label,code,flush=True)
