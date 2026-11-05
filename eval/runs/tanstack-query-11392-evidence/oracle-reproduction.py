import subprocess,os,pathlib,json,time,sys,shutil
side=sys.argv[1];repo=pathlib.Path('/dev/shm/rio-tanstack-work/negative-'+side);out=pathlib.Path('/dev/shm/rio-tanstack-work/oracle-'+side);out.mkdir(exist_ok=True)
env={**os.environ,'PATH':'/dev/shm/rio-tanstack-tools/node-v24.16.0-linux-x64/bin:'+os.environ['PATH'],'COREPACK_HOME':'/dev/shm/rio-tanstack-tools/corepack-cache','NODE_DISABLE_COMPILE_CACHE':'1','NX_DAEMON':'false','NX_NO_CLOUD':'true'}
node='/dev/shm/rio-tanstack-tools/node-v24.16.0-linux-x64/bin/node';package=repo/'packages/query-broadcast-client-experimental'
cmds=[('compile-dependencies',repo,[node,'node_modules/typescript/lib/tsc.js','-b','packages/query-core','packages/query-test-utils']),('types',repo,[node,'node_modules/typescript/lib/tsc.js','-b','packages/query-broadcast-client-experimental']),('eslint',package,[node,str(repo/'node_modules/eslint/bin/eslint.js'),'--format','json','./src']),('coverage',package,[node,str(repo/'node_modules/vitest/vitest.mjs'),'run','--coverage','--coverage.reporter=lcov','--coverage.reportsDirectory='+str(out/'coverage'),'--maxWorkers=2'])]
ledger=[]
for label,cwd,argv in cmds:
 start=time.monotonic()
 with open(out/(label+'.stdout.log'),'wb') as so,open(out/(label+'.stderr.log'),'wb') as se:
  try: code=subprocess.run(argv,cwd=cwd,env=env,stdout=so,stderr=se,timeout=400).returncode
  except subprocess.TimeoutExpired:code=124
 ledger.append(dict(label=label,argv=argv,cwd=str(cwd),exit_code=code,wall_time_seconds=time.monotonic()-start));print(side,label,code,flush=True)
 (out/'commands.json').write_text(json.dumps(ledger,indent=2))
final=pathlib.Path('/home/ubuntu/.t3/worktrees/rio/eval-run-tanstack-query/eval/runs/tanstack-query-11392-evidence')/('oracle-'+side);shutil.copytree(out,final,dirs_exist_ok=True)
