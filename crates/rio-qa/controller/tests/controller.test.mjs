import test from 'node:test';
import assert from 'node:assert/strict';
import { blake3 } from '@noble/hashes/blake3.js';
import { QaBackend, qaCellId, remainingExploration } from '../src/controller.mjs';

test('exploration skips actual visits per cell and excludes unrelated route guidance', () => {
  const mobile = { viewport: 'mobile', color_scheme: 'light' }, desktop = { ...mobile, viewport: 'desktop' };
  const root = { path: 'REVIEW.md', scope_dir: '', content_hash: 'a', lines: ['Keep input'] };
  const admin = { path: 'admin/REVIEW.md', scope_dir: 'admin', content_hash: 'b', lines: ['Admin requirement'] };
  const checkout = { path: 'checkout/REVIEW.md', scope_dir: 'checkout', content_hash: 'c', lines: ['Guest checkout'] };
  const guidance = { 'exploratory@/admin': [root, admin], 'exploratory@/checkout': [root, checkout] };
  const journey = { name: 'exploratory', covers: { routes: ['/admin', '/checkout'] }, steps: [{ at: '/admin' }, { at: '/checkout' }] };
  const completed = [{ journey: 'checkout', cell: mobile, visited_routes: ['/checkout'] }];
  const next = remainingExploration(journey, mobile, completed, guidance);
  assert.deepEqual(next.journey.steps, [{ at: '/admin' }]);
  assert.deepEqual(next.guidance.map(doc => doc.path), ['REVIEW.md', 'admin/REVIEW.md']);
  assert.equal(remainingExploration(journey, desktop, completed, guidance).journey.steps.length, 2);
  assert.equal(journey.steps.length, 2);
  completed[0].visited_routes.push('/admin');
  assert.equal(remainingExploration(journey, mobile, completed, guidance).journey.steps.length, 0);
});

test('controller uses the Worker canonical cell identity and separates baseline spending', () => {
  const chain = { journeys: ['add-to-cart', 'checkout'] }, cell = { viewport: 'mobile', color_scheme: 'light' };
  const canonical = '{"chain":["add-to-cart","checkout"],"color_scheme":"light","version":"head","viewport":"mobile"}';
  const expected = Buffer.from(blake3(Buffer.from(canonical))).toString('hex');
  assert.equal(qaCellId(chain, cell), expected);
  assert.notEqual(qaCellId(chain, cell, 'base'), expected);
  assert.notEqual(qaCellId(chain, { ...cell, viewport: 'desktop' }), expected);
});

test('cell startup diagnostics retain the stage without exposing persona credentials', async () => {
  const { EvidenceWriter } = await import('../src/evidence.mjs');
  const manifests = [];
  const writer = new EvidenceWriter({ sink: { manifest: async value => { manifests.push(structuredClone(value)); } } });
  const backend = new QaBackend({ contract: {}, criteria: [], writer, credentialEnv: { QA_PASSWORD: 'synthetic-private-value' } });
  await backend.failure({ stage: 'browser_start', chain: { journeys: ['checkout'] }, cell: { viewport: 'mobile', color_scheme: 'light' }, error: new Error('Failure synthetic-private-value') });
  assert.equal(writer.notes[0].stage, 'browser_start');
  assert.equal(writer.notes[0].reason, 'cell_failure');
  assert.ok(!JSON.stringify(manifests).includes('synthetic-private-value'));
});

test('interrupted checkpoints preserve collected findings and UX without finalizing run-wide rules', async () => {
  const { EvidenceWriter } = await import('../src/evidence.mjs');
  const checkpoints = [];
  const writer = new EvidenceWriter({ sink: { manifest: async () => {} } });
  const backend = new QaBackend({ contract: {}, criteria: [], writer,
    credentialEnv: { QA_PASSWORD: 'synthetic-private-value' },
    checkpoint: async value => checkpoints.push(structuredClone(value)) });
  const cell = { viewport: 'mobile', color_scheme: 'light' };
  const candidate = { rule_id: 'ui/no-feedback', observed: { text: 'synthetic-private-value' } };
  backend.completed.set('checkout', { journey: 'checkout', cell, outcome: 'cancelled', reason: 'budget',
    finding_candidates: [candidate], hypotheses: [{ rule_id: 'ui/no-feedback' }],
    qa_recommendations: [{ id: 'recommendation' }], ux_assessment: [{ status: 'observed_friction' }] });
  backend.probes.assessments.push({ scope: 'step', step: 1 }, { scope: 'run' });
  await backend.recordCellMetric({ chain: ['checkout'], journeys: ['checkout'], cell, wall_time_ms: 100 });
  const retained = checkpoints.at(-1);
  assert.equal(retained.outcome, 'partial');
  assert.equal(retained.qa_findings[0].rule_id, 'ui/no-feedback');
  assert.equal(retained.hypotheses.length, 1);
  assert.equal(retained.qa_recommendations.length, 1);
  assert.equal(retained.ux_assessment.length, 1);
  assert.deepEqual(retained.probe_assessments, [{ scope: 'step', step: 1 }]);
  assert.ok(!backend.probes.done, 'Checkpointing must not finalize the population');
  assert.ok(!JSON.stringify(retained).includes('synthetic-private-value'));
});
