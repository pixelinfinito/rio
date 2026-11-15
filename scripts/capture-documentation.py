#!/usr/bin/env python3
"""Capture actual Rio CLI output and current TUI fixture rendering as PNG + text."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, __version__ as pillow_version
from documentation import ROOT, digest

def run(args,**kw):
    return subprocess.run(args,check=True,text=True,capture_output=True,**kw).stdout

def paint(rows,width,path,font_path):
    font=ImageFont.truetype(str(font_path),18)
    bold_path=font_path.with_name(font_path.stem+'-Bold.ttf')
    bold=ImageFont.truetype(str(bold_path if bold_path.exists() else font_path),18)
    cell_width=11;cell_height=24;padding=24
    img=Image.new('RGB',(width*cell_width+padding*2,len(rows)*cell_height+padding*2),'#0E0F11');d=ImageDraw.Draw(img)
    for y,row in enumerate(rows):
        for x,cell in enumerate(row):
            bg=tuple(cell.get('bg') or (14,15,17));fg=tuple(cell.get('fg') or (232,233,236))
            left,top=padding+x*cell_width,padding+y*cell_height
            d.rectangle((left,top,left+cell_width-1,top+cell_height-1),fill=bg)
            if cell['text']:d.text((left,top),cell['text'],font=bold if cell.get('bold') else font,fill=fg)
    img.save(path,optimize=True)

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--binary',default='target/debug/rio');p.add_argument('--font',default='/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf');a=p.parse_args()
    binary=(ROOT/a.binary).resolve();font=Path(a.font);assets=ROOT/'docs/wiki/assets';assets.mkdir(exist_ok=True)
    commit=run(['git','rev-parse','HEAD'],cwd=ROOT).strip();version=run([str(binary),'--version']).strip();records=[]
    def record(id,mode,command,sources,width,height):
        records.append(dict(id=id,mode=mode,command=command,source_commit=commit,rio_version=version,dimensions=[width,height],font=font.name,font_sha256=digest(font.read_bytes()),font_size=18,pillow=pillow_version,demo_data=True,hashes={ext:digest((assets/f'{id}.{ext}').read_bytes()) for ext in ['png','txt']},sources={str(path.relative_to(ROOT)):digest(path.read_bytes()) for path in sources}))
    with tempfile.TemporaryDirectory(prefix='rio-doc-capture-') as temp:
        temp=Path(temp);env=os.environ.copy();env['RIO_DOCS_CAPTURE_DIR']=str(temp/'tui');env['NO_COLOR']='1'
        subprocess.run(['cargo','test','-p','rio-tui','--locked','--test','review','--test','init','--test','team','--test','qa','match','--','--test-threads=1'],cwd=ROOT,env=env,check=True)
        for path in sorted((temp/'tui').glob('*.json')):
            data=json.loads(path.read_text());id=path.stem
            paint(data['cells'],data['width'],assets/f'{id}.png',font)
            (assets/f'{id}.txt').write_text(path.with_suffix('.txt').read_text())
            family='review' if id.startswith('review') else 'init' if id.startswith('init') else 'qa' if id.startswith('qa') else 'team'
            sources=[*sorted((ROOT/'crates/rio-tui/src').rglob('*.rs')),ROOT/f'crates/rio-tui/tests/{family}.rs',ROOT/'crates/rio-tui/tests/common/mod.rs',Path(__file__).resolve()]
            record(id,'actual TUI renderer, synthetic fixture; displayed fixture version is demo data',f'cargo test -p rio-tui --test {family} match',sources,data['width'],data['height'])
        repo=temp/'demo';repo.mkdir();run(['git','init','-b','main'],cwd=repo);run(['git','config','user.name','Rio Demo'],cwd=repo);run(['git','config','user.email','demo@example.invalid'],cwd=repo)
        (repo/'README.md').write_text('# Demo project\n');run(['git','add','.'],cwd=repo);run(['git','commit','-m','Demo base'],cwd=repo)
        (repo/'README.md').write_text('# Demo project\n\nA small documentation change.\n')
        for k in list(env):
            if k.startswith('RIO_') or k in ('XDG_CONFIG_HOME','VIRTUAL_ENV'):env.pop(k,None)
        env.update(RIO_CONFIG_DIR=str(temp/'config'),NO_COLOR='1',CI='1',RIO_TUI='0')
        commands={'cli-version':['--version'],'cli-help':['--help'],'cli-doctor':['doctor'],'cli-review':['review','--offline','--no-tui','--ascii'],'cli-profile':['profile','show','rio/base']}
        for id,args in commands.items():
            result=subprocess.run([str(binary),*args],cwd=repo,env=env,text=True,capture_output=True)
            if result.returncode not in (0,4):raise ValueError(f'capture {id} failed: {result.stderr}')
            content=result.stdout.replace(str(temp),'$DEMO')
            content=re.sub(r'\b[0-9a-f]{64}\b','<deterministic-demo-hash>',content)
            content=re.sub(r'\b[0-9A-HJKMNP-TV-Z]{26}\b','<demo-run-id>',content)
            content=re.sub(r'\b\d+(?:\.\d+)?\s*(?:ms|s)\b','<time>',content)
            if id!='cli-version':
                content=re.sub(r'\b[0-9a-f]{40}\b','<demo-commit>',content)
                content=re.sub(r'(Review: )[0-9a-f]+',r'\1<demo-review-id>',content)
            content=re.sub(r'("free_space": )\d+',r'\1"<free-space-bytes>"',content)
            content=re.sub(r'\b\d+(?:\.\d+)?\s*(?:GiB|GB) free\b','<free-space> free',content)
            (assets/f'{id}.txt').write_text('$ rio '+' '.join(args)+'\n'+content)
            lines=(assets/f'{id}.txt').read_text().splitlines()
            # Full transcript is retained; image is a labeled viewport excerpt.
            if len(lines)>34:lines=lines[:32]+['… full output is available in the text transcript.']
            import textwrap
            lines=[part for line in lines for part in (textwrap.wrap(line,110,replace_whitespace=False,drop_whitespace=False) or [''])]
            width=max(80,max(map(len,lines)))
            paint([[dict(text=c) for c in line] for line in lines],width,assets/f'{id}.png',font)
            sources=[ROOT/'crates/rio-cli/src/main.rs',ROOT/'crates/rio-cli/src/config.rs',ROOT/'modules/profiles/base.yaml',Path(__file__).resolve()]
            record(id,'actual CLI in disposable synthetic repository; volatile IDs/paths/timing normalized','rio '+' '.join(args),sources,width,len(lines))
    (assets/'captures.json').write_text(json.dumps(dict(schema_version=1,captures=records),indent=2)+'\n')
    print(f'Captured {len(records)} screens in {assets}')
if __name__=='__main__':main()
