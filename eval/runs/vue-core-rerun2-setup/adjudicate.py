"""Reproduce automated adjudications from preserved rerun2 and independent evidence."""
import collections
import gzip
import json
import pathlib

RUNS = pathlib.Path(__file__).resolve().parent.parent

def read(path):
    if path.exists():
        return json.loads(path.read_text())
    with gzip.open(str(path) + '.gz', 'rt') as stream:
        return json.load(stream)

def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')

positive = RUNS / 'vue-core-12701-rerun2'
base_cmd = read(positive / 'independent-base-coverage-oracle-command.json')
head_cmd = read(positive / 'independent-coverage-oracle-attempt2-command.json')
assert base_cmd['exit_code'] == head_cmd['exit_code'] == 0
comparison = {'scope': 'Independent compiler-sfc unit coverage; same pinned revisions as Rio. This is not a new preregistered control.', 'base': {}, 'head': {}}
for side, folder, line in [('base', 'independent-base-coverage', 1029), ('head', 'independent-coverage-attempt2', 1031)]:
    coverage = read(positive / folder / 'coverage-final.json')
    source, counters = next(iter(coverage.items()))
    matches = [{'statement_id': key, 'span': span, 'hits': counters['s'][key]}
               for key, span in counters['statementMap'].items()
               if span['start']['line'] == line]
    assert matches and all(s['hits'] == 0 for s in matches)
    comparison[side] = {'source': source, 'fallback_line': line, 'statements': matches,
                        'coverage_file': f'{folder}/coverage-final.json',
                        'command': 'independent-base-coverage-oracle-command.json' if side == 'base' else 'independent-coverage-oracle-attempt2-command.json'}
comparison['assessment'] = 'The : undefined fallback for options.sourceMap === false is present at base line 1029 and moved to head line 1031. Both independent full compiler-sfc unit runs succeed; both record zero executions for that fallback. Valid pre-existing coverage gap shown as new, not an introduced gap.'
write(positive / 'independent-coverage-comparison.json', comparison)

for number in (12701, 15328):
    out = RUNS / f'vue-core-{number}-rerun2'
    report = read(out / 'report.json')
    verdicts = read(out / 'verdicts.json')
    previous = read(RUNS / f'vue-core-{number}-attempt-02' / 'verdicts.json')
    ledger = read(out / 'commands.json')
    assert ledger['base_sha'] == report['review']['base']
    assert ledger['head_sha'] == report['review']['head']
    assert all(value['succeeded'] for value in ledger['installations'].values())
    assert ledger['environment']['dependency_state'] == 'verified'
    assert not ledger['environment']['baseline_classification_ran']
    verdicts.update(reviewer='sub-agent rerun2-vue-core (automated)', verdict_source='automated',
                    independently_clean=previous['independently_clean'], positive_control=previous['positive_control'], misses=[])
    verdicts['notes'] += [
        'Same preregistered PR, base/head SHAs, install-plan.json and profile.yaml as attempt-02; Node/Corepack/pnpm pins preserved. See ../vue-core-rerun2-setup/toolchains.json and per-checkout *-package-manager.json. PUPPETEER_SKIP_DOWNLOAD=true; TMPDIR=/dev/shm. No dependency trust, tracked source changes, rebuild, or changes to crates/ or eval/*.py.',
        f'Independent earlier oracles reused only because SHAs and locks match: ../vue-core-{number}-evidence/base-oracle-commands.json, head-oracle-commands.json, base/head-checkout-verification.json and control-register.md. Exact raw logs are in that evidence directory.',
        'All diagnostic head entries are dependency_state=verified, but there are zero base entries. The new built-output compatibility guard prevents every baseline; the exact baseline_failed notes and affected IDs are in observations.json. Both frozen installations succeeded; generated ignored dist files cannot change the selected committed Tree inspected by this guard, so the reported build hint does not provide a setup-only repair under the pinned plan. Run retained without a redundant reinstall attempt.',
        'Run excluded from release metrics. Finding-level correctness is still adjudicated independently. The v2 evaluator maps every raw pre-existing/fixed state to informational pre-existing-hidden even when a setup-failure annotation is supplied. These raw labels are not treated as independently established base diagnostics.',
        'Root coverage selection now runs tests. Four private dependency roots report no_tests. The Vue dependent root selects browser e2e tests and fails because Chrome was intentionally not downloaded under the original install plan. Raw child stdout/stderr and coverage counters copied from the fresh Rio cache are indexed by rio-child-output-index.json; these files do not establish child executable/argv, which Rio does not serialize.',
        'Offline OSV audit skipped; no advisory safety claim. Secret scan passed. No independently established agent-layer miss; this assessment covers the registered deterministic scope only.',
    ]
    verdicts['findings'] = {}
    for finding in report['findings'] + report['risks']:
        location = finding['location']
        where = f"{location['path']}:{location['line_start']}"
        rule = finding['rule_id']
        if number == 12701 and finding['id'] == '4f7161d278ad6aa8d20db77df438febe2debff9a10914c752e5c1d08a28d6f9f':
            annotation = {'verdict': 'true-positive', 'reason': f'Confirmed introduced {rule} at {where}: nullable m.originalColumn assigned to a required number. Independent root pnpm check passes base and fails head with exactly this TS2322 (../vue-core-12701-evidence/base-oracle-1.log, head-oracle-1.log); later-fix-13366.diff adds the non-null assertion. This rerun now emits the exact diagnostic, also in rio-child-output/typecheck/packages%2Fcompiler-sfc/head/stdout.txt. Raw state unclassified is retained; missing baseline excludes the case from metrics but does not invalidate this independently established finding.'}
        elif rule == 'coverage/untested_change':
            assert number == 12701 and location['line_start'] == 1031
            annotation = {'verdict': 'pre-existing-shown', 'reason': 'Independent successful instrumented compiler-sfc unit runs show that the sourceMap:false : undefined fallback has zero hits at both base line 1029 and head line 1031. The PR moves the same fallback from the returned object to a local variable; its coverage gap predates the change. See independent-coverage-comparison.json, independent-base-coverage/coverage-final.json, independent-coverage-attempt2/coverage-final.json and the command/log siblings. Pinned clean checkouts verified in ../vue-core-rerun2-setup/positive-coverage-checkouts.json. Rio raw state new shows a valid pre-existing gap by default. The failed first independent oracle is preserved and not used as successful coverage evidence.'}
        else:
            assert rule.startswith('typecheck/')
            detail = ('Private composite tsconfig execution imports public source outside its file list and without root global declarations (TS6307/TS2304), or requires built declaration artifacts/module resolution unavailable to this private invocation. '
                      'See raw rio-child-output/typecheck/packages-private%2Fdts-test/head/stdout.txt and packages-private%2Fsfc-playground/head/stdout.txt. ')
            reason = (f'Environment observation {rule} at {where}, raw state {finding["state"]}: '+detail+
                      f'Independent root pnpm check/lint at the same pinned revisions (../vue-core-{number}-evidence/base/head-oracle-commands.json and *-oracle-*.log) '+
                      ('pass both sides, so this is not evidence of an introduced source defect. ' if number == 15328 else 'establish only the introduced TS2322; these other diagnostics do not appear in the repository root check. ')+
                      'Ancestor tsconfig support repairs public-package checks but private roots still produce setup diagnostics. The exact affected-ID groups and unavailable base checks are preserved in observations.json. Raw hidden state is informational under methodology v2, not proof that a baseline ran.')
            annotation = {'verdict': 'environment-failure', 'reason': reason}
        verdicts['findings'][finding['id']] = annotation
    if number == 12701:
        expectation = verdicts['positive_control']['expected'][0]
        expectation['finding_ids'] = ['4f7161d278ad6aa8d20db77df438febe2debff9a10914c752e5c1d08a28d6f9f']
        expectation['evidence'] = '../vue-core-12701-evidence/control-register.md preregistered this introducing change. Independent root corepack pnpm check: pinned base exits 0; pinned head exits 2 with TS2322 at compileScript.ts:1327, number | null assigned to number. Root lint passes both. See base/head-oracle-1.log and later-fix-13366.diff. This rerun emits the matching finding, independently confirmed true-positive. Baseline/setup remains ineligible, so this is an observed detection and contributes no eligible recall denominator.'
        verdicts['commands'] += ['independent: cwd='+cmd['cwd']+' argv='+json.dumps(cmd['argv']) for cmd in (read(out/'independent-coverage-oracle-command.json'), head_cmd, base_cmd)]
    else:
        verdicts['notes'].append('Independent deterministic clean assessment reused: root typecheck/lint pass at base and head, shared instrumented tests pass (12/14), and all 24 introduced statements execute. See ../vue-core-15328-evidence/changed-statement-coverage.json and original coverage JSON. This rerun coverage shared/root unit checks pass, with no uncovered-change risk. An excluded Rio run is not a clean confirmation.')
    assert set(verdicts['findings']) == {f['id'] for f in report['findings']+report['risks']}
    write(out / 'verdicts.json', verdicts)
    print(number, collections.Counter(a['verdict'] for a in verdicts['findings'].values()))
