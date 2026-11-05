#!/usr/bin/env python3
"""Regenerate the schema table between markers in docs/profiles.md."""
import json
from pathlib import Path
root = Path(__file__).resolve().parents[1]
schema = json.loads((root / 'schemas/profile-v1.json').read_text())
rows = ['| Key | Type | Required |', '| --- | --- | --- |']
def visit(properties, prefix='', required=()):
    for name, prop in properties.items():
        key = prefix + name
        kind = prop.get('type', prop.get('$ref', 'one of the schema alternatives'))
        if isinstance(kind, list): kind = '/'.join(kind)
        rows.append(f'| `{key}` | `{kind}` | {"yes" if name in required else "no"} |')
        if 'properties' in prop:
            visit(prop['properties'], key + '.', prop.get('required', []))
        if prop.get('type') == 'array' and 'properties' in prop.get('items', {}):
            visit(prop['items']['properties'], key + '[].', prop['items'].get('required', []))
visit(schema['properties'], required=schema.get('required', []))
path = root / 'docs/profiles.md'
text = path.read_text()
start, end = '<!-- schema:start -->', '<!-- schema:end -->'
path.write_text(text.split(start)[0] + start + '\n\n' + '\n'.join(rows) + '\n\n' + end + text.split(end)[1])
