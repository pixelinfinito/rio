import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProbeRun, builtinProbeRules } from '../src/probes.mjs';

test('style adoption raises the emitted severity from info to the declared warning', async () => {
  const rules = await builtinProbeRules();
  const sample = { page: 'http://app/', journey: 'checkout', step: 1, cell: { viewport: 'mobile', color_scheme: 'light' },
    evidence: { screenshot: 's', dom: 'd' }, measurements: {
      eligible: { 'ui/gradient-background': ['a','b','c','d','e','f'] },
      candidates: [{ rule_id: 'ui/gradient-background', element_path: 'a', measurements: { area_ratio: .4 } }], gaps: [],
    } };
  for (const adopt of [[], ['ui/gradient-background']]) {
    const run = new ProbeRun({ rules, overrides: { adopt } }); run.record(sample);
    const finding = run.finalize().findings[0];
    assert.equal(finding.severity, adopt.length ? 'warning' : 'info');
    assert.equal(finding.adopted, !!adopt.length);
  }
});

test('baseline assessment excludes disabled rules and measurement gaps', async () => {
  const run = new ProbeRun({ rules: await builtinProbeRules(), overrides: { disable: ['ui/gradient-background'] } });
  const cell = { viewport: 'mobile', color_scheme: 'light' };
  run.record({ page: 'http://app/', journey: 'checkout', step: 2, cell,
    evidence: { screenshot: 's', dom: 'd' }, measurements: {
      eligible: { 'mobile/tap-target': [], 'ui/low-contrast': [], 'ui/gradient-background': [] },
      candidates: [], gaps: [{ rule_id: 'ui/low-contrast', reason: 'unreadable frame' }],
    } });
  assert.deepEqual(run.assessments.map(row => row.rule_id), ['mobile/tap-target']);
  assert.deepEqual(run.assessments[0].cell, cell);
});

test('project disable patterns support rule ids, wildcards, alternatives and character classes', async () => {
  const rules = await builtinProbeRules();
  const run = new ProbeRun({ rules, overrides: { disable: ['mobile/{tap-target,input-zoom}', 'ui/[gl]*', 'ui/raw-primiti?e'] } });
  for (const id of ['mobile/tap-target', 'mobile/input-zoom', 'ui/gradient-background', 'ui/low-contrast', 'ui/layout-shift', 'ui/raw-primitive']) assert.equal(run.enabled(id), false, id);
  for (const id of ['mobile/viewport-meta', 'ui/accent-border-card', 'ui/console-error']) assert.equal(run.enabled(id), true, id);
  assert.equal(new ProbeRun({ rules, overrides: { disable: ['*'] } }).enabled('ui/console-error'), false);
});

test('minority threshold is strict, min_sample is inclusive, and missing artifacts cannot become findings', async () => {
  const rules = await builtinProbeRules();
  function record(run, count) {
    return run.record({ page: 'http://app/', journey: 'checkout', step: 1, cell: { viewport: 'mobile', color_scheme: 'light' }, evidence: { screenshot: 'a.png', dom: 'a.json' }, measurements: {
      eligible: { 'ui/gradient-background': Array.from({ length: count }, (_, i) => `section-${i}`) },
      candidates: [{ rule_id: 'ui/gradient-background', element_path: 'section-0', measurements: { area_ratio: .4 } }], gaps: [],
    } });
  }
  const threshold = new ProbeRun({ rules }); record(threshold, 5);
  assert.equal(threshold.finalize().summaries.find(row => row.rule_id === 'ui/gradient-background').reason, 'consistent_usage');
  const minority = new ProbeRun({ rules }); record(minority, 6);
  assert.equal(minority.finalize().findings.length, 1);
  assert.throws(() => record(minority, 6), /already finalized/);
  const insufficient = new ProbeRun({ rules }); record(insufficient, 4);
  assert.equal(insufficient.finalize().findings.length, 0);
  const missing = new ProbeRun({ rules });
  assert.throws(() => missing.record({ journey: 'checkout', step: 1, cell: { viewport: 'mobile', color_scheme: 'light' }, evidence: { screenshot: 'a.png' }, measurements: {} }), /screenshot and DOM/);
});
