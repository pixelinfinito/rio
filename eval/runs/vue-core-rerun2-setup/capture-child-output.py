"""Copy Rio check artifacts before the unmodified runner removes its temporary cache."""
import hashlib
import json
import pathlib
import shutil
import sys
import time

out = pathlib.Path(sys.argv[1]).resolve()
index = {}
while True:
    try:
        metadata = json.loads((out / 'commands.json').read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        time.sleep(0.1)
        continue
    temporary = metadata.get('disposable_directory')
    if temporary:
        for checks in pathlib.Path(temporary, 'cache').glob('*/runs/*/checks'):
            for source in checks.rglob('*'):
                if not source.is_file() or source.name == 'findings.json':
                    continue
                relative = source.relative_to(checks)
                dest = out / 'rio-child-output' / relative
                try:
                    data = source.read_bytes()
                    digest = hashlib.sha256(data).hexdigest()
                    if index.get(str(relative), {}).get('sha256') == digest:
                        continue
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(data)
                    index[str(relative)] = {'source': str(source), 'bytes': len(data), 'sha256': digest}
                except FileNotFoundError:
                    pass
    if metadata.get('finished_utc'):
        break
    time.sleep(0.1)
(out / 'rio-child-output-index.json').write_text(json.dumps(index, indent=2) + '\n')
print(f'Preserved {len(index)} raw check artifact files; executable/argv not serialized by Rio.')
