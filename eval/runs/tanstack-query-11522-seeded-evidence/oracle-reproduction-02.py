import pathlib,json,os,subprocess,time,shutil
base=pathlib.Path('/dev/shm/rio-tanstack-work/seed-base');head=base.parent/'seed-head';out=base.parent/'seed-oracle-02';out.mkdir(exist_ok=True)
node='/dev/shm/rio-tanstack-tools/node-v24.16.0-linux-x64/bin/node';env={**os.environ,'PATH':str(pathlib.Path(node).parent)+':'+os.environ['PATH'],'COREPACK_HOME':'/dev/shm/rio-tanstack-tools/corepack-cache','NODE_DISABLE_COMPILE_CACHE':'1'};ledger=[]
cmds=[]
for side,repo in [('base',base),('head',head)]:
 cmds.append((side+'-install',repo,['corepack','pnpm','--filter','root','--filter','@tanstack/query-broadcast-client-experimental...','install','--frozen-lockfile','--trust-lockfile','--offline','--ignore-scripts','--store-dir','/dev/shm/rio-tanstack-tools/pnpm-store']))
 cmds.extend([(side+'-compile-dependencies',repo,[node,'node_modules/typescript/lib/tsc.js','-b','--force','packages/query-core','packages/query-test-utils']),(side+'-types',repo,[node,'node_modules/typescript/lib/tsc.js','--noEmit','--pretty','false','-p','packages/query-broadcast-client-experimental'])])
for label,cwd,argv in cmds:
 start=time.monotonic()
 with open(out/(label+'.stdout.log'),'wb') as so,open(out/(label+'.stderr.log'),'wb') as se:code=subprocess.run(argv,cwd=cwd,env=env,stdout=so,stderr=se,timeout=400).returncode
 ledger.append(dict(label=label,argv=argv,cwd=str(cwd),exit_code=code,wall_time_seconds=time.monotonic()-start));(out/'commands.json').write_text(json.dumps(ledger,indent=2));print(label,code,flush=True)
final=pathlib.Path('/home/ubuntu/.t3/worktrees/rio/eval-run-tanstack-query/eval/runs/tanstack-query-11522-seeded-evidence/oracle-02');shutil.copytree(out,final,dirs_exist_ok=True)
