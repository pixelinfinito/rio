#!/usr/bin/env python3
"""Build/check Rio's documentation. Generation and rendering never publish."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = Path('docs/documentation-manifest.json')
CORPUS = Path('crates/rio-cli/assets/docs.json')
LOCALES = ('en', 'pt-BR')
PREFIX = {'en': 'EN', 'pt-BR': 'PT-BR'}
LINK = re.compile(r'!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)')

def digest(data):
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()

def read_manifest(root=ROOT):
    return json.loads((root / MANIFEST).read_text())

def slug(text):
    return re.sub(r'[^\w\- ]', '', text.lower().replace('`', '')).replace(' ', '-')

def wiki_name(id, locale):
    return PREFIX[locale] + '-' + '-'.join(part.capitalize() for part in id.split('-'))

def anchors(text):
    seen, result = {}, set()
    text = re.sub(r'```.*?```', '', text, flags=re.S)
    for heading in re.findall(r'^#{1,6}\s+(.+)$', text, re.M):
        name = slug(heading)
        count = seen.get(name, 0)
        result.add(name + (f'-{count}' if count else ''))
        seen[name] = count + 1
    return result

def agent_topic(entry, root=ROOT):
    text = re.sub(r'<!--.*?-->', '', (root / entry['agent']).read_text(), flags=re.S)
    parts = re.split(r'^## (.+)\n', text, flags=re.M)
    intro = parts[0].split('\n', 1)[1].strip()
    sections = [dict(id=slug(parts[i]), title=parts[i].strip(), body=parts[i+1].strip()) for i in range(1, len(parts), 2)]
    return {k:entry[k] for k in ('id','title','summary','keywords','related')} | dict(prerequisites=intro, sections=sections, index_parent=entry.get('index_parent'))

def corpus(manifest, root=ROOT):
    topics = [agent_topic(t, root) for t in manifest['topics'] if t.get('agent')]
    encoded = json.dumps(topics, ensure_ascii=False, separators=(',',':'))
    return json.dumps(dict(revision=digest(encoded), topics=topics), ensure_ascii=False, separators=(',',':')) + '\n'

def source_hash(entry, root=ROOT):
    return digest(''.join(path + ':' + digest((root / path).read_bytes()) + '\n' for path in sorted(entry['sources'])))

def links_errors(files, origins=None):
    """Validate local Markdown/asset links; network resources are publication checks."""
    errors=[]
    for path, text in files.items():
        if not path.endswith('.md') or (origins is not None and path not in origins):
            continue
        for raw in LINK.findall(re.sub(r'```.*?```','',text,flags=re.S)):
            url = urlsplit(raw)
            if url.scheme or raw.startswith('//'):
                continue
            target = (Path(path).parent / unquote(url.path)).as_posix() if url.path else path
            import posixpath
            target = posixpath.normpath(target)
            if target not in files and target + '.md' in files:
                target += '.md'
            if target not in files:
                errors.append(f'{path}: missing link {raw}')
            elif url.fragment and target.endswith('.md') and unquote(url.fragment) not in anchors(files[target]):
                errors.append(f'{path}: missing anchor {raw}')
    return errors

def validate(manifest, root=ROOT, require_pages=True):
    errors=[]
    ids=[t['id'] for t in manifest['topics']]
    if len(ids)!=len(set(ids)): errors.append('duplicate topic IDs')
    if manifest.get('locales') != list(LOCALES): errors.append('locales must be en and pt-BR')
    if manifest.get('landing_topic') not in ids:errors.append('missing landing topic')
    sidebar=manifest.get('sidebar',[])
    if not sidebar:errors.append('missing sidebar navigation')
    for item in sidebar:
        if item.get('topic') not in ids:errors.append('unknown sidebar topic')
        if set(item.get('labels',{}))!=set(LOCALES) or not all(item.get('labels',{}).values()):errors.append('missing localized sidebar label')
    for t in manifest['topics']:
        id=t['id']
        if not re.fullmatch('[a-z][a-z0-9-]{0,63}',id) or id in ('list','search'): errors.append(f'{id}: invalid/reserved ID')
        for related in t.get('related',[]):
            if related not in ids: errors.append(f'{id}: missing related topic {related}')
        if set(t.get('pages',{})) != set(LOCALES): errors.append(f'{id}: missing locale mapping')
        for source in t['sources']:
            if not (root/source).is_file(): errors.append(f'{id}: missing source {source}')
        if not t.get('availability'): errors.append(f'{id}: missing availability')
        if require_pages and all((root/p).is_file() for p in t['sources']) and t.get('source_review') != source_hash(t,root): errors.append(f'{id}: source review is stale')
        if require_pages:
            for locale,path in t.get('pages',{}).items():
                p=root/path
                if not p.is_file(): errors.append(f'{id}: missing {locale} page');continue
                text=p.read_text()
                if any(ord(c)<32 and c not in '\n\t' for c in text): errors.append(f'{path}: invalid control character')
                if not text.startswith('# '): errors.append(f'{path}: missing title')
                required = ['## Outcome','## Prerequisites','## Steps','## Expected results','## Troubleshooting','## Next steps'] if locale=='en' else ['## Objetivo','## Pré-requisitos','## Passos','## Resultados esperados','## Solução de problemas','## Próximos passos']
                if t.get('kind','guide')=='guide':
                    for h in required:
                        if h not in text: errors.append(f'{path}: missing {h}')
            en=root/t['pages']['en'];pt=root/t['pages']['pt-BR']
            if en.exists() and pt.exists():
                review=t.get('translation_review',{})
                if review.get('en')!=digest(en.read_bytes()) or review.get('pt-BR')!=digest(pt.read_bytes()):errors.append(f'{id}: stale translation review')
        if t.get('agent'):
            if not (root/t['agent']).is_file(): errors.append(f'{id}: missing agent topic');continue
            a=agent_topic(t,root)
            if not a['prerequisites'] or not a['sections']: errors.append(f'{id}: missing prerequisite/sections')
            sections=[s['id'] for s in a['sections']]
            if len(sections)!=len(set(sections)): errors.append(f'{id}: duplicate section IDs')
            if len(sections)>12 or len(t['summary'])>72 or len(t['title'])>64: errors.append(f'{id}: metadata too large')
            for s in a['sections']:
                if len(s['title'])>64 or not re.fullmatch('[a-z][a-z0-9-]{0,63}',s['id']):errors.append(f'{id}: invalid/oversized section')
            if '\x1b' in json.dumps(a,ensure_ascii=False):errors.append(f'{id}: ANSI in content')
    inv=root/'docs/command-inventory.json'
    if inv.exists():
        coverage={c:t for t in manifest['topics'] for c in t.get('commands',[])}
        for command in json.loads(inv.read_text()):
            name=command['command']
            if name not in coverage: errors.append(f'undocumented command: {name}');continue
            t=coverage[name]
            if require_pages:
                for path in t['pages'].values():
                    if not (root/path).exists():continue
                    text=(root/path).read_text()
                    for arg in command['arguments']:
                        marker='--'+arg['long'] if arg['long'] else '<'+arg['id']+'>'
                        if marker not in text: errors.append(f'{path}: undocumented {name} {marker}')
    assets=root/'docs/wiki/assets/captures.json'
    if not assets.is_file():errors.append('missing screenshot provenance manifest')
    if assets.exists():
        for a in json.loads(assets.read_text()).get('captures',[]):
            for suffix in ['png','txt']:
                p=root/'docs/wiki/assets'/f"{a['id']}.{suffix}"
                if not p.exists() or digest(p.read_bytes()) != a['hashes'].get(suffix):errors.append(f"{a['id']}: missing/modified {suffix}")
            for path,hashed in a.get('sources',{}).items():
                if not (root/path).exists() or digest((root/path).read_bytes())!=hashed:errors.append(f"{a['id']}: stale capture source {path}")
        capture_ids={a['id'] for a in json.loads(assets.read_text()).get('captures',[])}
        for t in manifest['topics']:
            for id in t.get('screenshots',[]):
                if id not in capture_ids:errors.append(f"{t['id']}: missing capture {id}")
                for path in t['pages'].values():
                    if (root/path).exists():
                        text=(root/path).read_text()
                        if not re.search(r'!\[[^\]]+\]\([^)]*'+re.escape(id)+r'\.png\)',text):errors.append(f'{path}: missing translated screenshot alt text: {id}')
    return errors

def replace_generated(text,key,body):
    start,end=f'<!-- {key}:start -->',f'<!-- {key}:end -->'
    block=start+'\n\n'+body.strip()+'\n\n'+end
    if start in text: return text.split(start)[0]+block+text.split(end,1)[1]
    return text.rstrip()+'\n\n'+block+'\n'

def command_tables(manifest, root=ROOT):
    inventory=json.loads((root/'docs/command-inventory.json').read_text())
    descriptions=json.loads((root/'docs/argument-descriptions.json').read_text())
    out={}
    for t in manifest['topics']:
        commands=[c for c in inventory if c['command'] in t.get('commands',[])]
        if not commands:continue
        for locale,path in t['pages'].items():
            if not (root/path).exists():continue
            title='Command reference' if locale=='en' else 'Referência de comandos'
            rows=['<details>', '<summary>'+('All command options' if locale=='en' else 'Todas as opções dos comandos')+'</summary>\n',f'## {title}\n']
            for command in commands:
                rows += [f"### `{command['command']}`\n",'| Argument | Meaning | Default / choices |' if locale=='en' else '| Argumento | Significado | Padrão / valores |','| --- | --- | --- |']
                for a in command['arguments']:
                    name='--'+a['long'] if a['long'] else '<'+a['id']+'>'
                    description=descriptions.get(command['command']+' '+a['id'],descriptions.get(a['id']))
                    if not description:raise ValueError(f"missing translated argument description: {command['command']} {a['id']}")
                    detail=description[locale]
                    values=', '.join(a['values']) or ', '.join(a['defaults']) or '—'
                    rows.append(f"| `{name}` | {detail.replace('|','/')} | `{values}` |")
            rows.append('\n</details>')
            out[path]=replace_generated((root/path).read_text(),'commands','\n'.join(rows))
    coverage={command:t for t in manifest['topics'] for command in t.get('commands',[])}
    for locale in LOCALES:
        path=f'docs/wiki/{locale}/reference.md'
        rows=['## '+('Command lookup' if locale=='en' else 'Consulta de comandos'),'','| '+('Command | Guide / options' if locale=='en' else 'Comando | Guia / opções')+' |','| --- | --- |']
        for command in inventory:
            name=command['command'];owner=coverage[name]
            label=(root/owner['pages'][locale]).read_text().splitlines()[0].removeprefix('# ')
            target=Path(owner['pages'][locale]).name+'#'+slug(name)
            rows.append(f'| `{name}` | [{label}]({target}) |')
        out[path]=replace_generated(out.get(path,(root/path).read_text()),'command-index','\n'.join(rows))
    return out

def generate(manifest,root=ROOT,check=False):
    outputs={str(CORPUS):corpus(manifest,root)}
    if (root/'docs/argument-descriptions.json').exists():outputs.update(command_tables(manifest,root))
    for path,data in outputs.items():
        p=root/path
        if check:
            if not p.exists() or p.read_text()!=data:raise ValueError(f'{path}: generated file is stale')
        else:
            p.parent.mkdir(parents=True,exist_ok=True);p.write_text(data)
    if len(outputs[str(CORPUS)].encode())>512*1024:raise ValueError('embedded payload exceeds 512 KiB')

def render(manifest,destination,root=ROOT):
    destination=Path(destination)
    if destination.exists() and any(destination.iterdir()):raise ValueError('render destination must be empty (use a fresh staging directory)')
    destination.mkdir(parents=True,exist_ok=True)
    revision=digest(json.dumps({'landing_topic':manifest['landing_topic'],'sidebar':manifest['sidebar']},ensure_ascii=False,sort_keys=True)+corpus(manifest,root)+''.join(path+digest((root/path).read_bytes()) for t in manifest['topics'] for path in t['pages'].values())+''.join(p.name+digest(p.read_bytes()) for p in sorted((root/'docs/wiki/assets').glob('*')) if p.is_file()))
    commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
    version=re.search(r'version = "([^"]+)"',(root/'Cargo.toml').read_text())[1]
    names={path:wiki_name(t['id'],locale) for t in manifest['topics'] for locale,path in t['pages'].items()}
    files={}
    for t in manifest['topics']:
        for locale,path in t['pages'].items():
            text=(root/path).read_text()
            landing=t['id']==manifest['landing_topic']
            navigation=[]
            if not landing:
                navigation.append(f"[{'Home' if locale=='en' else 'Início'}]({wiki_name(manifest['landing_topic'],locale)})")
                category='reference' if t.get('kind')=='reference' else 'guides'
                if category!=t['id']:
                    label=('Reference' if locale=='en' else 'Referência') if category=='reference' else ('Guides' if locale=='en' else 'Guias')
                    navigation.append(f'[{label}]({wiki_name(category,locale)})')
            navigation.extend(['**English**' if locale=='en' else f"[English]({wiki_name(t['id'],'en')})",'**Português (Brasil)**' if locale=='pt-BR' else f"[Português (Brasil)]({wiki_name(t['id'],'pt-BR')})"])
            nav=' · '.join(navigation)+'\n\n'
            def link(match):
                raw=match.group(1);url=urlsplit(raw)
                if url.scheme or raw.startswith('//'):return match.group(0)
                import posixpath
                resolved=posixpath.normpath(str(Path(path).parent/unquote(url.path))) if url.path else path
                if resolved in names: target=names[resolved]
                elif resolved.startswith('docs/wiki/assets/'):
                    target=manifest['wiki_url'].replace('github.com/','raw.githubusercontent.com/wiki/').removesuffix('/wiki')+'/assets/'+Path(resolved).name
                elif resolved.startswith('docs/wiki/'):
                    raise ValueError(f'{path}: unknown Wiki link {raw}')
                elif (root/resolved).is_file():target='https://github.com/pixelinfinito/rio/blob/'+commit+'/'+resolved
                else: raise ValueError(f'{path}: broken link {raw}')
                if url.fragment:target+='#'+url.fragment
                return match.group(0).replace(raw,target)
            text=LINK.sub(link,text)
            footer='\n\n---\n'+('Written for' if locale=='en' else 'Documentação para')+f" Rio {version} · ["+('source' if locale=='en' else 'código')+f" {commit[:7]}](https://github.com/pixelinfinito/rio/tree/{commit}). "
            footer+=('Check your version with' if locale=='en' else 'Confira sua versão com')+f" `rio --version`. Docs `{revision[:12]}`.\n"
            headings=re.findall(r'^## (.+)$',re.sub(r'```.*?```','',text,flags=re.S),re.M)
            toc=''
            if not landing and len(text)>3000 and len(headings)>3:
                counts={};entries=[]
                for heading in headings:
                    anchor=slug(heading);n=counts.get(anchor,0);counts[anchor]=n+1
                    entries.append(f"- [{heading}](#{anchor}"+(f'-{n}' if n else '')+')')
                toc=('On this page' if locale=='en' else 'Nesta página')+':\n\n'+'\n'.join(entries)+'\n\n'
            title,body=text.split('\n',1)
            files[names[path]+'.md']=nav+title+'\n\n'+toc+body.strip()+footer
    files['Home.md']=files[wiki_name(manifest['landing_topic'],'en')+'.md']
    files['_Sidebar.md']='[Rio](Home)\n\n'+'\n\n'.join('**'+('English' if locale=='en' else 'Português (Brasil)')+'**\n\n'+'\n'.join(f"- [{item['labels'][locale]}]({wiki_name(item['topic'],locale)})" for item in manifest['sidebar']) for locale in LOCALES)+'\n'
    errors=links_errors(files)
    if errors:raise ValueError('\n'.join(errors))
    for path,data in files.items():(destination/path).write_text(data)
    assets=root/'docs/wiki/assets'
    if assets.exists():shutil.copytree(assets,destination/'assets')
    hashes={str(p.relative_to(destination)):digest(p.read_bytes()) for p in sorted(destination.rglob('*')) if p.is_file()}
    (destination/'.rio-wiki-manifest.json').write_text(json.dumps(dict(schema_version=1,source_commit=commit,docs_revision=revision,files=hashes),indent=2)+'\n')
    return len(files)

def budgets(binary,output):
    import tiktoken
    import importlib.metadata
    encoding=tiktoken.get_encoding('o200k_base')
    binary=str(Path(binary).resolve());rows=[]
    def run(args,cap,token_cap):
        p=subprocess.run([binary,'docs',*args],capture_output=True,check=False)
        if p.returncode not in (0,2):raise ValueError(f'docs failed: {args}: {p.stderr.decode()}')
        content=p.stdout.decode();count=len(encoding.encode(content))
        if len(p.stdout)>cap or count>token_cap:raise ValueError(f'budget exceeded: {args}: {len(p.stdout)} bytes / {count} tokens')
        rows.append(dict(arguments=args,bytes=len(p.stdout),tokens=count))
        return content
    index=json.loads(run(['--format','json'],12288,3000))
    run([],4096,800);run(['list'],4096,800)
    for t in json.loads((ROOT/CORPUS).read_text())['topics']:
        run([t['id']],8192,1800)
        data=json.loads(run([t['id'],'--format','json'],12288,3000))
        for section in data['data']['available_sections']:
            run([t['id'],'--section',section],4096,800)
            run([t['id'],'--section',section,'--format','json'],12288,3000)
    for query in ['rio','profile','the','a','dependency mismatch','nonexistent-zz']:
        run(['search',query,'--limit','10'],4096,800)
        run(['search',query,'--limit','10','--format','json'],12288,3000)
    for args in [['missing'],['review','--section','missing'],['search',''],['search','x'*257],['search','x','--limit','11']]:
        run([*args,'--format','json'],12288,3000)
    # Bound every possible ten-hit combination, including topic-only matches.
    catalog=json.loads((ROOT/CORPUS).read_text())
    candidates=[]
    for t in catalog['topics']:
        candidates.append(dict(topic=t['id'],section='',title=t['title'],match='topic guidance'))
        candidates.extend(dict(topic=t['id'],section=s['id'],title=s['title'],match='section guidance') for s in t['sections'])
    lines=[f"{h['topic']}"+(f" --section {h['section']}" if h['section'] else '')+f": {h['title']} ({h['match']})\n" for h in candidates]
    prefix=f"Rio {index['rio_version']} · docs {index['docs_revision'][:12]}\n"
    suffix='More matches: yes; refine the query or increase --limit.\n'
    # Sum independent maxima: conservative even if token merges cross boundaries.
    for cap,size in [(4096,lambda x:len(x.encode())),(800,lambda x:len(encoding.encode(x)))]:
        if size(prefix)+10*max(map(size,lines))+size(suffix)>cap:raise ValueError('worst-case search metadata exceeds text budget')
    envelope={k:v for k,v in index.items() if k!='data'}|{'kind':'search','data':{'results':[],'more':False}}
    base=json.dumps(envelope,ensure_ascii=False,separators=(',',':'))+'\n'
    entries=[json.dumps(h,ensure_ascii=False,separators=(',',':')) for h in candidates]
    for cap,size in [(12288,lambda x:len(x.encode())),(3000,lambda x:len(encoding.encode(x)))]:
        if size(base)+10*(max(map(size,entries))+1)>cap:raise ValueError('worst-case search metadata exceeds JSON budget')
    record=dict(tokenizer='o200k_base',tiktoken=importlib.metadata.version('tiktoken'),docs_revision=index['docs_revision'],payload_bytes=(ROOT/CORPUS).stat().st_size,measurements=rows)
    Path(output).write_text(json.dumps(record,indent=2)+'\n')
    print(f'{len(rows)} outputs within byte/token limits; payload {record["payload_bytes"]} bytes')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    sub.add_parser('generate');sub.add_parser('check')
    review=sub.add_parser('review');review.add_argument('ids',nargs='+',help='explicitly attest reviewed EN/pt-BR page pairs')
    p=sub.add_parser('render');p.add_argument('destination')
    p=sub.add_parser('budgets');p.add_argument('--binary',default='target/debug/rio');p.add_argument('--output',default='docs/documentation-budgets.json')
    args=parser.parse_args();m=read_manifest()
    if args.command=='generate':generate(m)
    elif args.command=='review':
        for t in m['topics']:
            if t['id'] in args.ids:
                t['translation_review']={locale:digest((ROOT/path).read_bytes()) for locale,path in t['pages'].items()}
                t['source_review']=source_hash(t)
        (ROOT/MANIFEST).write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n')
    elif args.command=='check':
        errors=validate(m)
        files={str(p.relative_to(ROOT)):p.read_text() for p in (ROOT/'docs/wiki').rglob('*.md')}
        files.update({str(p.relative_to(ROOT)):'' for p in (ROOT/'docs/wiki/assets').rglob('*') if p.is_file()})
        origins=set(files)
        import posixpath
        for path,text in list(files.items()):
            for raw in LINK.findall(re.sub(r'```.*?```','',text,flags=re.S)):
                url=urlsplit(raw)
                if url.scheme:continue
                target=posixpath.normpath(str(Path(path).parent/unquote(url.path))) if url.path else path
                p=ROOT/target
                if p.is_file() and target not in files:
                    files[target]=p.read_text() if p.suffix=='.md' else ''
        errors+=links_errors(files,origins)
        if errors:raise ValueError('\n'.join(errors))
        generate(m,check=True)
        with tempfile.TemporaryDirectory() as temp:render(m,temp)
        print(f'{len(m["topics"])} topics validated in both locales')
    elif args.command=='render':print(f'{render(m,args.destination)} Wiki pages rendered to {args.destination}')
    elif args.command=='budgets':budgets(args.binary,args.output)
if __name__=='__main__':
    try:main()
    except (ValueError,KeyError,OSError) as e:
        print(f'documentation: {e}',file=sys.stderr);sys.exit(1)
