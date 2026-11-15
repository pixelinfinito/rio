#!/usr/bin/env python3
"""Generate exact schema facts for the Wiki and compact embedded reference topics."""
import json
from pathlib import Path
import yaml
from documentation import ROOT, MANIFEST, replace_generated

def compact(value):
    return json.dumps(value,ensure_ascii=False,separators=(',',':'))

def fields(schema,prefix=''):
    rows=[]
    for key,value in schema.get('properties',{}).items():
        path=prefix+key
        detail=value.get('type','enum' if 'enum' in value else 'value')
        detail=compact(detail) if not isinstance(detail,str) else detail
        if key in schema.get('required',[]):detail+=' *'
        for flag in ['const','enum','default','minimum','maximum','pattern','minItems','maxItems','minLength','maxLength','format','uniqueItems']:
            if flag in value:detail+=f'; {flag}={compact(value[flag])}'
        if value.get('additionalProperties') is False:detail+='; extra=false'
        for union in ('oneOf','anyOf'):
            if union in value: detail+='; '+union+'='+compact(value[union])
        rows.append((path,detail))
        rows+=fields(value,path+'.')
        if 'items' in value:
            items=value['items']
            if 'properties' in items:rows+=fields(items,path+'[].')
            elif 'enum' in items:rows.append((path+'[]','enum='+compact(items['enum'])))
            elif 'type' in items:rows.append((path+'[]',str(items['type'])))
    return rows

def generate(root=ROOT,check=False):
    manifest=json.loads((root/MANIFEST).read_text()); outputs={}
    sets=[('profile', 'Profile fields', 'Campos de perfil','schemas/profile-v1.json'),('qa-config','QA environment fields','Campos do ambiente QA','schemas/qa-config-v1.json'),('qa-journey','Journey fields','Campos de jornada','schemas/journey-v1.json'),('qa-seed','Seed fields','Campos de dados iniciais','schemas/qa-seed-v1.json'),('qa-fixtures','Fixture fields','Campos de fixtures','schemas/qa-fixtures-v1.json')]
    for name,title,pt,path in sets:
        schema=json.loads((root/path).read_text())
        rows=fields(schema)
        # Complete human reference; compact agent chunks below remain bounded.
        for locale in ('en','pt-BR'):
            heading=title if locale=='en' else pt
            body=f'## {heading}\n\n'+('Generated from ' if locale=='en' else 'Gerado de ')+f'`{path}`. '
            body+=('`*` means required. `extra=false` rejects unknown keys. Semantic validation still applies.\n\n' if locale=='en' else '`*` indica obrigatório. `extra=false` rejeita chaves desconhecidas. A validação semântica também se aplica.\n\n')
            body+='| '+('Field | Type / constraints' if locale=='en' else 'Campo | Tipo / restrições')+' |\n| --- | --- |\n'
            body+='\n'.join(f'| `{key}` | `{value.replace("|","/")}` |' for key,value in rows)
            page=f'docs/wiki/{locale}/modules.md'
            outputs[page]=replace_generated(outputs.get(page,(root/page).read_text()),name+'-schema',body)
        chunks=[];current=[];size=0
        for key,value in rows:
            line=f'{key}: {value}'
            if size+len(line)>2400 and current:chunks.append(current);current=[];size=0
            current.append(line);size+=len(line)+1
        if current:chunks.append(current)
        for i,chunk in enumerate(chunks,1):
            id=f'{name}-fields-{i}'
            # All generated references are discoverable, but grouped under their
            # parent in the default index to keep its 800-token ceiling.
            agent=f'docs/agent/{id}.md'
            lines=[]
            for n in range(0,len(chunk),10):lines.append(f'## fields-{n//10+1}\n'+'\n'.join(chunk[n:n+10]))
            outputs[agent]=f'# {title} {i}\n\nSchema reference for {name}. Edit the corresponding YAML intentionally; validate with rio profile validate or rio qa validate. * means required; extra=false rejects unknown keys. Semantic constraints and prerequisites are in the related guide.\n\n'+'\n\n'.join(lines)+'\n'
            entry=next((t for t in manifest['topics'] if t['id']==id),None)
            if not entry:
                guide='profiles' if name=='profile' else 'qa'
                entry=dict(id=id,title=f'{title} {i}',summary=f'{name} schema fields, part {i}',related=[guide,'modules'],commands=[],sources=[path],keywords=[name,'fields','schema'],agent=agent,pages={l:f'docs/wiki/{l}/{id}.md' for l in ['en','pt-BR']},kind='reference',availability='implemented schema',screenshots=[],index_parent='modules');manifest['topics'].append(entry)
            for locale in ('en','pt-BR'):
                heading=title if locale=='en' else pt
                page=entry['pages'][locale]
                outputs[page]=f'# {heading} {i}\n\n'+('Use these exact keys with the [profile guide](profiles.md) or [QA guide](qa.md). See [Modules](modules.md) for complete schema tables and semantic rules. `*` marks required fields. Commands and keys are intentionally untranslated.\n\n' if locale=='en' else 'Use estas chaves exatas com o [guia de perfis](profiles.md) ou [guia QA](qa.md). Veja [Módulos](modules.md) para tabelas completas e regras semânticas. `*` marca campos obrigatórios. Comandos e chaves preservam a grafia original.\n\n')+'```text\n'+'\n'.join(chunk)+'\n```\n'
    module_rows=[]
    for path in sorted((root/'modules').glob('**/module.yaml')):
        data=yaml.safe_load(path.read_text())
        options=fields(data.get('schema',{}))
        module_rows.append((data['name'],data['version'],data['kind'],options,str(path.relative_to(root))))
    for locale in ('en','pt-BR'):
        text='## '+('Built-in module options' if locale=='en' else 'Opções dos módulos integrados')+'\n\n'
        for name,version,kind,rows,path in module_rows:
            text+=f'### `{name}@{version}` ({kind})\n\n'
            text+=('Source: ' if locale=='en' else 'Fonte: ')+f'`{path}`\n\n'
            text+='```text\n'+'\n'.join(f'{k}: {v}' for k,v in rows)+'\n```\n\n' if rows else ('No configurable options.\n\n' if locale=='en' else 'Sem opções configuráveis.\n\n')
        page=f'docs/wiki/{locale}/modules.md';outputs[page]=replace_generated(outputs[page],'module-options',text)
    # Compact module-specific options are placed in related existing topic bodies.
    mapping={'rio/qa':'qa','rio/security':'security','rio/council':'council','rio/verify':'budgets','rio/checks':'modules','rio/graph':'modules','rio/prepare':'modules','rio/report':'modules','rio/agents':'modules','rio/triage':'modules'}
    grouped={}
    for name,version,kind,rows,path in module_rows:
        if name not in mapping:continue
        grouped.setdefault(mapping[name],[]).append(f'{name}@{version}:\n'+'\n'.join(f'{k}: {v}' for k,v in rows))
    for id,blocks in grouped.items():
        path=f'docs/agent/{id}.md';original=(root/path).read_text().split('\n<!-- schema-options:start -->')[0].rstrip()
        outputs[path]=original+'\n\n<!-- schema-options:start -->\n## option-fields\n'+'\n\n'.join(blocks)+'\n'
    # Related references stay discoverable from modules without inflating index.
    module=next(t for t in manifest['topics'] if t['id']=='modules')
    refs=[t['id'] for t in manifest['topics'] if t.get('index_parent')=='modules']
    # A dedicated sections listing groups reference IDs; related remains short.
    path='docs/agent/modules.md'
    original=outputs.get(path,(root/path).read_text()).split('\n## schema-topics\n')[0].rstrip()
    outputs[path]=original+'\n\n## schema-topics\nRead one exact schema topic: '+', '.join(refs)+'.\n'
    for locale in ('en','pt-BR'):
        page=f'docs/wiki/{locale}/reference.md'
        body='## '+('Schema lookup topics' if locale=='en' else 'Tópicos de campos dos schemas')+'\n\n'+'\n'.join(f'- [{id}]({id}.md)' for id in refs)
        outputs[page]=replace_generated((root/page).read_text(),'schema-topics',body)
    outputs[str(MANIFEST)]=json.dumps(manifest,ensure_ascii=False,indent=2)+'\n'
    for path,text in outputs.items():
        if check:
            if not (root/path).exists() or (root/path).read_text()!=text:raise ValueError(f'{path}: generated schema reference stale')
        else:(root/path).write_text(text)
    return manifest

if __name__=='__main__':
    import sys
    generate(check='--check' in sys.argv)
