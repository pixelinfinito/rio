import subprocess,os,time,json,pathlib,sys
root=pathlib.Path('/home/ubuntu/.t3/worktrees/rio/eval-run-vue-core/eval/runs')
case,side,cwd,node=sys.argv[1:]
out=root/f'vue-core-{case}-evidence';out.mkdir(exist_ok=True)
env={**os.environ,'PATH':f'/tmp/node-v{node}-linux-x64/bin:/tmp/vue-eval-tools/node_modules/.bin:'+os.environ['PATH'],'PUPPETEER_SKIP_DOWNLOAD':'true'}
commands=[['corepack','pnpm','check'],['corepack','pnpm','lint']]
if case=='15328': commands += [['corepack','pnpm','exec','vitest','run','--project','unit','packages/shared/__tests__/looseEqual.spec.ts','--coverage','--coverage.reporter=json','--coverage.reportsDirectory='+str(out/f'{side}-coverage'),'--maxWorkers=2']]
ledger=[]
for i,cmd in enumerate(commands):
 start=time.monotonic();log=out/f'{side}-oracle-{i+1}.log'
 with log.open('w') as f:
  p=subprocess.run(cmd,cwd=cwd,env=env,stdout=f,stderr=subprocess.STDOUT)
 ledger.append(dict(argv=cmd,cwd=cwd,exit_code=p.returncode,wall_time_seconds=round(time.monotonic()-start,3),log=str(log),environment={'PATH':env['PATH'],'PUPPETEER_SKIP_DOWNLOAD':'true'}))
 (out/f'{side}-oracle-commands.json').write_text(json.dumps(ledger,indent=2)+'\n')
 print(case,side,i,p.returncode,flush=True)
