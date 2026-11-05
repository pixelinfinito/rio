#!/usr/bin/env python3
"""Independent statement-coverage gate over coverage.py's retained JSON."""
import gzip
import json
import sys

with gzip.open(sys.argv[1], 'rt') as f:
    report = json.load(f)
file = report['files'][sys.argv[2]]
print(json.dumps({'file': sys.argv[2], 'summary': file['summary'],
                  'missing_lines': file['missing_lines'],
                  'missing_branches': file.get('missing_branches', [])}, indent=2))
sys.exit(1 if file['missing_lines'] else 0)
