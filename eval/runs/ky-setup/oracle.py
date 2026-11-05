"""Capture independent ky tools. Inputs and every subprocess are retained as evidence.
Usage: python3 oracle.py PR SIDE [command-label ...]
Disposable checkouts are deliberately outside the evaluation repository.
"""
import json, os, pathlib, subprocess, sys, time
pr, side = sys.argv[1:3]
root = pathlib.Path('/tmp/rio-ky-eval')
checkout = root / f'{pr}-{side}'
out = pathlib.Path(__file__).resolve().parent.parent / f'ky-{pr}-oracle'
node = root / ('node-v18.20.8-linux-x64/bin' if pr == '578' else 'node-v22.20.0-linux-x64/bin')
assert (node/'node').is_file()
env = dict(os.environ, PATH=f'{node}:{os.environ["PATH"]}')
commands = {
 'install': ['npm','ci','--package-lock=true','--no-audit','--no-fund'],
 'node': ['node','--version'],
 'npm': ['npm','--version'],
 'versions': ['npm','ls','--depth=0'],
 'tsc': ['node_modules/.bin/tsc','--noEmit','--pretty','false','-p','.'],
 'browser-tsc': ['node_modules/.bin/tsc','--pretty','false','-p','tsconfig.eval-browser.json'],
 'browser-tsc-reinstalled': ['node_modules/.bin/tsc','--pretty','false','-p','tsconfig.eval-browser.json'],
 'browser-tsc-fixed': ['node_modules/.bin/tsc','--pretty','false','-p','tsconfig.eval-browser.json'],
 'tsc-reinstalled': ['node_modules/.bin/tsc','--noEmit','--pretty','false','-p','.'],
 'xo': ['node_modules/.bin/xo'],
 'xo-serial': ['node_modules/.bin/xo'],
 'xo-changed': ['node_modules/.bin/xo','source/types/options.ts','source/utils/body.ts','test/browser.ts','test/stream.ts'],
 'build': ['npm','run','build'],
 'test-types': ['node_modules/.bin/tsc','--pretty','false','-p','tsconfig.test.json'],
 'node-tests': ['node_modules/.bin/ava','test/**','!test/browser.ts','--concurrency=2'],
 'stream-tests': ['node_modules/.bin/ava','test/stream.ts','--timeout=2m','--concurrency=1'],
 'node-tests-slow': ['node_modules/.bin/ava','test/**','!test/browser.ts','--timeout=2m','--concurrency=2'],
 'node-tests-final': ['node_modules/.bin/ava','test/**','!test/browser.ts','--timeout=2m','--concurrency=2'],
 'browsers': ['node_modules/.bin/playwright','install','--with-deps'],
 'browser-tests': ['node_modules/.bin/ava','test/browser.ts','--concurrency=2'],
 'clean': ['git','status','--short','--untracked-files=no'],
}
ledger_path = out / f'{side}-commands.json'
ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else []
for label in sys.argv[3:]:
 argv=commands[label]; start=time.monotonic()
 log=out/f'{side}-{label}.log'
 if log.exists(): raise RuntimeError(f'Refusing overwrite: {log}')
 with log.open('wb') as stream:
  try:
   p=subprocess.run(argv,cwd=checkout,env=env,stdout=stream,stderr=subprocess.STDOUT,timeout=1200)
   code=p.returncode
  except subprocess.TimeoutExpired:
   code=124;stream.write(b'\nORACLE TIMEOUT 1200 seconds\n')
 ledger.append({'label':label,'argv':argv,'cwd':str(checkout),'environment':{'PATH':env['PATH']},'exit_code':code,'wall_time_ms':int((time.monotonic()-start)*1000),'log':log.name})
 (out/f'{side}-{label}-command.json').write_text(json.dumps(ledger[-1],indent=2)+'\n')
 # Merge the current disk ledger so separately started invocations do not erase completed entries.
 current=json.loads(ledger_path.read_text()) if ledger_path.exists() else []
 merged={item['label']:item for item in current}
 merged.update({item['label']:item for item in ledger})
 ledger_path.write_text(json.dumps(list(merged.values()),indent=2)+'\n')
 print(pr,side,label,code,ledger[-1]['wall_time_ms'],flush=True)
