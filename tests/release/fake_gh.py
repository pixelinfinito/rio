"""Disk-backed gh double for publisher lifecycle tests; never contacts a network."""
import json
import os
from pathlib import Path
import shutil
import sys

root = Path(os.environ['FAKE_GH_ROOT'])
state_path = root / 'state.json'
state = json.loads(state_path.read_text())
args = sys.argv[1:]
call = {'args': args}
state['calls'].append(call)


def finish(code=0, output='', error=''):
    state_path.write_text(json.dumps(state))
    if output:
        print(output)
    if error:
        print(error, file=sys.stderr)
    raise SystemExit(code)


def response(value):
    finish(output=json.dumps(value))


if args[0] == 'api':
    method = args[args.index('-X') + 1] if '-X' in args else 'GET'
    path = next(arg for arg in args[1:] if arg.startswith('repos/'))
    payload = json.loads(Path(args[args.index('--input') + 1]).read_text()) if '--input' in args else None
    call.update(method=method, path=path, payload=payload)
    if method == 'GET':
        if path.endswith('/releases?per_page=100'):
            assert '--paginate' in args and '--slurp' in args
            # Exercise a matching release on a later page, including drafts.
            response([[], [state['release']] if state['release'] else []])
        if state['release'] is None:
            finish(1, error='HTTP 404: Not Found')
        if '/releases/tags/' in path and state['release']['draft']:
            finish(1, error='HTTP 404: Not Found')
        response(state['release'])
    if method == 'DELETE':
        state['release'] = None
        shutil.rmtree(root / 'uploads', ignore_errors=True)
        finish()
    if method == 'POST':
        state['next_id'] += 1
        state['release'] = dict(payload, id=state['next_id'], assets=[], html_url='https://example.invalid/release')
        response(state['release'])
    if method == 'PATCH':
        state['release'].update(payload)
        if payload['make_latest'] == 'true':
            state['latest'] = state['release']['tag_name']
        response(state['release'])
if args[:2] == ['release', 'upload']:
    asset = Path(args[3])
    uploads = root / 'uploads'
    uploads.mkdir(exist_ok=True)
    shutil.copyfile(asset, uploads / asset.name)
    state['release']['assets'] = [value for value in state['release']['assets'] if value['name'] != asset.name]
    state['release']['assets'].append({'name': asset.name})
    finish()
if args[:2] == ['release', 'download']:
    destination = Path(args[args.index('--dir') + 1])
    for asset in (root / 'uploads').iterdir():
        shutil.copyfile(asset, destination / asset.name)
    if os.environ.get('FAKE_GH_CORRUPT_DOWNLOAD'):
        asset = destination / os.environ['FAKE_GH_CORRUPT_DOWNLOAD']
        asset.write_bytes(asset.read_bytes() + b'corruption')
    finish()
if args[:2] == ['attestation', 'verify']:
    if os.environ.get('FAKE_GH_ATTESTATION_FAILURE'):
        finish(1, error='attestation subject verification failed')
    if not Path(args[args.index('--bundle') + 1]).is_file():
        finish(1, error='attestation bundle missing')
    finish(output='Verified local fixture attestation')
finish(2, error=f'Unexpected fake gh command: {args!r}')
