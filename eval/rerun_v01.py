#!/usr/bin/env python3
"""Rebuild the canonical v0.1 rerun from pinned raw reports and adjudications."""
from pathlib import Path
import subprocess
import sys

import evaluate as e

SELECTION = e.ROOT / 'eval/runs/v0.1-rerun-selection.json'
DOCUMENT = e.ROOT / 'docs/evaluation/v0.1-rerun.md'
DIRECTORY = DOCUMENT.with_suffix('')


def narrative(records, summary, historical):
    """All measured numbers come from records; the hand summary is comparison text."""
    all_metrics, verified = summary['eligible'], summary['verified_only']
    old = e.metrics([r for r in historical if r['environment']['eligible']])
    control_text = lambda m: f'{m["positive_control_detected"]}/{m["positive_control_expected"]}'
    trusted = [r for r in records if r['environment']['eligible'] and
               r['environment']['dependency_state'] == 'trusted']
    blocked = sorted({r['repository'] for r in records
                      if any('baseline_failed: linked dependency' in n
                             for n in r['environment']['notes'])})
    clean = next(r for r in records if r['repository'] == 'pydantic/pydantic' and r['case_id'] == '14213')
    hidden = sum(f['verdict'] == 'pre-existing-hidden' for f in clean['findings'])
    ky = next(r for r in records if r['repository'] == 'sindresorhus/ky' and r['case_id'] == '578')
    old_eligible = [r for r in historical if r['environment']['eligible']]
    hidden_false_alerts = sum(f['verdict'] == 'false-positive' and
                             f['finding']['state'] in {'pre-existing', 'fixed'}
                             for r in old_eligible for f in r['findings'])
    newly_useful = [(before, after) for before, after in zip(historical, records)
                    if before['environment']['eligible'] and before['verdict'] != 'useful'
                    and after['verdict'] == 'useful']
    real = all_metrics['positive_control_by_kind']['real-pr']
    seeded = all_metrics['positive_control_by_kind']['seeded-mutation']
    return f'''## Worked rerun and comparison with the hand summary

This is a reproducible v2 rescoring of the original raw reports, not a new Rio
execution. [The selection manifest](../../eval/runs/v0.1-rerun-selection.json)
chooses the NOTES files' final/scored attempts, one per case. It retains canonical
excluded cases to show the blocked repositories; earlier retries stay in the
attempt ledger under `eval/runs/`. Run `python3 eval/rerun_v01.py` from the repo
root to rebuild the v2 records, aggregate, narrative, and rendered document.
Original `record.json` files and NOTES remain historical v1 observations.

| Record-derived comparison | Historical v1 eligible | V2 verified only | V2 all eligible |
| --- | ---: | ---: | ---: |
| Eligible cases | {old['eligible_prs']} | {verified['eligible_prs']} | {all_metrics['eligible_prs']} |
| Detected / expected controls | {control_text(old)} | {control_text(verified)} | {control_text(all_metrics)} |
| TP causes per PR | {old['cause_counts']['true-positive']} | {verified['cause_counts']['true-positive']} | {all_metrics['cause_counts']['true-positive']} |
| FP causes per PR | {old['cause_counts']['false-positive']} | {verified['cause_counts']['false-positive']} | {all_metrics['cause_counts']['false-positive']} |
| Useful cases | {old['useful_prs']} | {verified['useful_prs']} | {all_metrics['useful_prs']} |

The historical eligible view reproduces the control detections and FP cause count
in [the hand summary](v0.1-rerun-summary.md). Those historical FP totals are
distinct causes **within each PR**, with {old['unique_cause_counts']['false-positive']}
unique repository/cause keys because the pydantic-settings connection-string
alert recurs in separate PRs. V2 re-derives visibility from the raw state:
{hidden_false_alerts} formerly adjudicated FP findings are `pre-existing` and
become informational `pre-existing-hidden`. These are the mitmproxy dummy secret
and both pydantic-settings connection-string alerts. Their independent defect
reasons remain in the records, but Rio hides these diagnostics by default.
The remaining scored FP is Hono's generated Deno mirror coverage alert.
Unique eligible FP repository/cause keys now total
{all_metrics['unique_cause_counts']['false-positive']}. This is why precision and FP counts differ from the
hand summary rather than reproducing its visible-noise assumptions.

The v2 verified-only usefulness count increases for {len(newly_useful)} cases:
{', '.join(after['repository'] + ' / ' + after['case_id'] for _, after in newly_useful)}.
Pydantic #14213 has {hidden} hidden findings and is independently clean: its new
verdict is `{clean['verdict']}`. The other newly useful cases have only hidden
false alerts. Raw reports and adjudicator reasons are unchanged.

All-eligible recall differs from the hand summary because trusted baselines now
admit {len(trusted)} cases. ky #578 contributes
{len(ky['positive_control']['expected'])} independently established browser-config
expectation, {sum(bool(x['finding_ids']) for x in ky['positive_control']['expected'])}
detections and a deterministic miss; Rio's default tsc configuration passes both
sides. The structlog seed contributes a detected `new` type error. Real control
recall is {real['detected']}/{real['expected']}; seeded recall is
{seeded['detected']}/{seeded['expected']}. These remain small, correlated samples.
The seeded cap and missing control-count/per-language requirements prevent a go.

### Trusted-mode observations

{len(trusted)} trusted cases have successful applicable base/head check pairs and
are now explicitly eligible: {', '.join(r['repository'] + ' / ' + r['case_id'] for r in trusted)}.
The structlog seed demonstrates classification of a nonempty diagnostic as `new`;
empty ky reports establish executed pairs, not successful detection of the browser
configuration bug. Trust is an environment choice, not verified dependencies.
The stricter metric view excludes these cases.

### Blocked monorepos and repository accounting

{len(blocked)} repositories retain linked-workspace baseline failures:
{', '.join(blocked)}. They receive no release metric credit. Independent oracles
may establish real defects in these excluded cases without establishing a working
Rio baseline. Setup also exposed lockfile/tool/configuration limitations documented
in the corresponding NOTES files. Fatal tRPC #7903 JSON lacks review metadata and
has no normalizable record; its raw attempts remain outside this aggregate.

The selected evidence spans {len({r['repository'] for r in records})} distinct
repositories, with {len({r['repository'] for r in records if r['environment']['eligible']})}
having eligible cases ({len({r['repository'] for r in records if r['environment']['eligible'] and r['environment']['dependency_state'] == 'verified'})}
verified-only). The repository total differs from the hand summary because Hono
and mitmproxy substitutes are counted alongside the failed original tRPC and
pydantic-ai assignments. Selected canonical cases are not the number of all
capture attempts.

The generated decision is **{summary['decision']}**, rather than the hand
summary's no-go: this rubric reserves no-go for an adequate sample. The measured
quality metrics also change with the visibility rule; the generated statistics
and decision reasons retain every computed gate.
Neither this rescoring nor the extra trusted observations establishes readiness.
'''


def rebuild():
    paths = [SELECTION.parent / p for p in e.read_json(SELECTION)]
    records, historical = [], []
    for path in paths:
        original = path.with_name('record.json')
        if not original.exists():
            original = path.with_name('excluded-record.json')
        old = e.read_json(original)
        historical.append(old)
        report_path = Path(old['report_path'])
        if not report_path.is_absolute():
            report_path = e.ROOT / report_path
        relative_report = report_path.relative_to(e.ROOT).as_posix()
        record = e.build_record(e.read_json(report_path), e.read_json(path.with_name('verdicts.json')),
                                relative_report)
        e.write_json(path, record)
        records.append(record)
    relative_paths = [p.relative_to(e.ROOT).as_posix() for p in paths]
    relative_selection = SELECTION.relative_to(e.ROOT).as_posix()
    summary_path = (DIRECTORY / 'summary.json').relative_to(e.ROOT).as_posix()
    cli = [sys.executable, 'eval/evaluate.py']
    subprocess.run([*cli, 'aggregate', *relative_paths, '--select', relative_selection,
                    '--out', summary_path], cwd=e.ROOT, check=True)
    summary = e.read_json(e.ROOT / summary_path)
    narrative_path = DIRECTORY / 'narrative.md'
    narrative_path.write_text(narrative(records, summary, historical))
    subprocess.run([*cli, 'render', *relative_paths, '--select', relative_selection,
                    '--version', 'v0.1 rerun', '--narrative', str(narrative_path),
                    '--out', str(DOCUMENT)], cwd=e.ROOT, check=True)
    return summary


if __name__ == '__main__':
    rebuild()
