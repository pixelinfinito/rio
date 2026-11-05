"""Attach the frozen external npm installation to an unchanged ky manifest.
The package-lock is evidence only: ky has no upstream committed lockfile.
Recreate the external installation with npm ci --package-lock=true from that lock
and the original package.json before replaying the runner install plan.
"""
import hashlib, json, pathlib, sys
pr=sys.argv[1]
setup=pathlib.Path(__file__).resolve().parent
pins=json.loads((setup/f'{pr}-dependencies.json').read_text())
manifest=pathlib.Path('package.json')
assert hashlib.sha256(manifest.read_bytes()).hexdigest()==pins['manifest_sha256'], 'manifest differs'
deps=pathlib.Path(pins['external_node_modules'])
assert (deps/'.package-lock.json').is_file(), 'recreate the frozen external npm installation first'
assert hashlib.sha256((deps/'.package-lock.json').read_bytes()).hexdigest()==pins['installed_lock_sha256'], 'installation metadata changed'
assert not pathlib.Path('node_modules').exists()
pathlib.Path('node_modules').symlink_to(deps,target_is_directory=True)
print(f'Attached frozen dependency installation for ky #{pr}; trusted, not upstream verified.')
print('external package lock SHA-256:',pins['package_lock_sha256'])
print('installed npm metadata SHA-256:',pins['installed_lock_sha256'])
