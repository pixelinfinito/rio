#!/usr/bin/env python3
"""Validate eval cases (schemas/eval-case-v1.json) and match reports against their expectations.

Usage: python3 -I eval/cases.py validate CASE.json [CASE.json | DIR ...]
"""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evaluate as e  # noqa: E402

CASE_SCHEMA = e.ROOT / 'schemas/eval-case-v1.json'


def validate_case(case):
    """Schema validation plus the invariants JSON Schema cannot express."""
    e.validate(case, CASE_SCHEMA)
    for i, expected in enumerate(case['expected']):
        for j, loc in enumerate(expected['locations']):
            if loc['line_end'] < loc['line_start']:
                raise ValueError(f'$.expected[{i}].locations[{j}]: line_end precedes line_start')
            if loc['symbol_line'] is not None and loc['symbol_path'] == '':
                raise ValueError(f'$.expected[{i}].locations[{j}]: file-level location has a symbol_line')
    if expected_trigger_placeholder(case):
        raise ValueError('$.expected: replace the TODO trigger before using the case')
    provenance = case['provenance']
    if 'overlap' in provenance:
        fix_files = set(provenance.get('fix', {}).get('files', []))
        if not set(provenance['overlap']) <= set(case['input']['files']) & fix_files:
            raise ValueError('$.provenance.overlap must list files changed by both the input and the fix')
    return case


def expected_trigger_placeholder(case):
    return any(x['trigger'].strip().upper().startswith('TODO') for x in case['expected'])


def load_cases(paths):
    """Read case files; directories contribute their *.json files (sorted)."""
    cases, files = [], []
    for path in map(Path, paths):
        files += sorted(path.glob('*.json')) if path.is_dir() else [path]
    seen = set()
    for path in files:
        case = validate_case(e.read_json(path))
        if case['id'] in seen:
            raise ValueError(f'duplicate case id {case["id"]}: {path}')
        seen.add(case['id'])
        cases.append((case, path))
    return cases


def report_findings(report):
    return report.get('findings', []) + report.get('risks', []) + report.get('security', [])


def location_matches(finding, expected_location):
    """A reported location matches when it is in the same file and either names the same
    enclosing symbol (symbol paths are compared by their last segment, so `mod.fn`
    matches `fn`) or overlaps the expected lines. File-level expectations (empty
    symbol_path) match any location in the file."""
    path, symbol = expected_location['path'], expected_location['symbol_path']
    for loc in [finding['location'], *finding.get('locations', [])]:
        if loc['path'] != path:
            continue
        if not symbol:
            return True
        reported = loc.get('symbol_path') or ''
        if reported and reported.replace('::', '.').split('.')[-1] == symbol.replace('::', '.').split('.')[-1]:
            return True
        if loc['line_start'] <= expected_location['line_end'] and loc['line_end'] >= expected_location['line_start']:
            return True
    return False


def caught(case, report):
    """Per expected finding, the IDs of reported findings that match any of its locations.
    An expectation that names an `agent` is caught only by that agent's findings."""
    findings = report_findings(report)
    return [sorted({f['id'] for f in findings for loc in x['locations'] if location_matches(f, loc)
                    and (not x.get('agent') or f.get('source', {}).get('agent') == x['agent'])})
            for x in case['expected']]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('validate', help='validate case files or directories of case files')
    p.add_argument('paths', nargs='+')
    args = parser.parse_args(argv)
    for case, path in load_cases(args.paths):
        print(f'Valid: {path} ({case["label"]} {case["id"]})')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError) as error:
        sys.exit(f'case error: {error}')
