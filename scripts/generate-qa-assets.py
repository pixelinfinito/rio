#!/usr/bin/env python3
"""Keep the controller's privacy catalog identical to rio-core's source."""
import argparse
import json
from pathlib import Path
import tomllib

root = Path(__file__).resolve().parents[1]
source = root / 'modules/adapters/common/secrets.toml'
target = root / 'crates/rio-qa/controller/src/secrets-catalog.json'
parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
content = json.dumps(tomllib.loads(source.read_text()), indent=2) + '\n'
if args.check:
    if target.read_text() != content:
        raise SystemExit('QA secret catalog is stale; run python3 scripts/generate-qa-assets.py')
else:
    target.write_text(content)
