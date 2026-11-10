import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openBrowser } from '../src/browser.mjs';
import { EvidenceWriter } from '../src/evidence.mjs';
import { JourneySession } from '../src/session.mjs';
import { builtinProbeRules } from '../src/probes.mjs';
import { contract, validateContract } from '../src/contracts.mjs';
import { executeReplay } from '../src/replay.mjs';
import { restrictedMcp } from '../src/mcp.mjs';
import { FixtureClient } from '../src/fixture-client.mjs';

const viewport = { name: 'mobile', width: 390, height: 844, mobile: true, touch: true };
const cell = { viewport: 'mobile', color_scheme: 'light' };
const journey = { name: 'checkout', persona: 'shopper', goal: 'Buy without repeating my address', steps: [{ do: 'Delivery', expect: 'Address accepted' }, { do: 'Billing', expect: 'Order placed' }], success: ['Order placed'] };
const json = result => JSON.parse(result.content[0].text);
const connect = async bridge => {
  const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.server.connect(b);
  const client = new Client({ name: 'scripted-harness', version: '1' }); await client.connect(a); return client;
};
async function setup(run) {
  const server = createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1>Checkout</h1><label>Delivery address<input id="address"></label><button id="next" onclick="document.querySelector(\'label\').firstChild.textContent=\'Billing address\';document.querySelector(\'input\').value=\'\';document.querySelector(\'h1\').textContent=\'Billing\'">Continue</button><button id="pay" onclick="document.querySelector(\'h1\').textContent=\'Order placed\'">Pay</button>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await openBrowser({ viewport, journey: 'checkout', allowedOrigins: [origin] });
  const objects = new Map(), writer = new EvidenceWriter({ sink: { put: async (key, bytes) => { objects.set(key, bytes); return { storage: 'local', link: key }; }, manifest: async () => {} } });
  const criteria = await builtinProbeRules();
  const guidance = [{ path: 'REVIEW.md', content_hash: 'a'.repeat(64), lines: ['Reuse the delivery address for billing with an edit option.'] }];
  const session = new JourneySession({ browser, writer, journey, cell, criteria, guidance });
  const bridge = await session.bridge({ allowedOrigins: [origin] }), client = await connect(bridge);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return result;
  };
  try { await run({ browser, writer, session, client, call, origin, criteria, guidance, objects }); }
  finally { await client.close(); await bridge.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

const advice = evidence => ({ rule_id: 'ux/task-efficiency', steps: [1, 2], route_pattern: '/checkout', friction_target: { kind: 'flow', target: 'billing-address' },
  observed_friction: 'The same address had to be entered in delivery and billing.', evidence,
  basis: { guidance: [{ path: 'REVIEW.md', hash: 'a'.repeat(64), start_line: 1, end_line: 1 }] },
  proposed_improvement: 'Reuse delivery details with an edit option for a different billing address.', expected_benefit: 'Expected to reduce repeated typing.',
  trade_offs: ['A different billing address must remain editable.'], priority: 'medium', confidence: 'high' });

for (const depends of [true, false]) test(`TLS rejection skips only a journey that depends on the host: ${depends}`, async () => setup(async ({ call, client, browser, session, writer, origin, objects }) => {
  session.fixtures = new FixtureClient({ endpoint: origin, sanitizer: writer.sanitizer, allowedOrigins: [origin],
    fetchImpl: async () => Response.json({ events: [{ kind: 'tls_pinned', host: 'payments.example.test' }] }) });
  session.capturedMessages = () => session.fixtures.collect(browser);
  await call('browser_navigate', { url: origin });
  assert.deepEqual(json(await call('read_dependencies')).failures, [{ kind: 'tls_pinned', host: 'payments.example.test' }]);
  if (depends) {
    const skip = { step: 1, outcome: 'skipped', blocked_dependency: 'payments.example.test', reason: 'Payment submission needs this service, which rejected the run CA.' };
    assert.ok((await client.callTool({ name: 'step_done', arguments: { ...skip, blocked_dependency: 'invented.example' } })).isError);
    assert.ok((await client.callTool({ name: 'step_done', arguments: { ...skip, outcome: 'passed' } })).isError);
    assert.ok((await client.callTool({ name: 'step_done', arguments: { ...skip, reason: '' } })).isError);
    const boundary = json(await call('step_done', skip));
    const result = await session.finish();
    assert.equal(result.outcome, 'skipped'); assert.equal(result.reason, 'precondition_failed');
    assert.equal(result.steps.length, 1); assert.deepEqual(result.evidence, boundary.evidence);
    assert.ok(result.ux_assessment.every(row => row.reason === 'precondition_failed'));
    assert.ok(result.evidence.some(id => writer.artifacts.find(row => row.id === id)?.kind === 'screenshot'));
  } else {
    await call('step_done', { step: 1, outcome: 'passed' });
    await call('step_done', { step: 2, outcome: 'passed' });
    assert.equal((await session.finish()).outcome, 'passed');
  }
  assert.ok([...objects.values()].some(bytes => bytes.toString().includes('tls_pinned')));
  const valid = validateContract(contract('qa-replay-v1'));
  for (const event of browser.replayEvents) assert.ok(valid(event), JSON.stringify(valid.errors));
}));

test('conflicting owner expectations retain both sources and evidence without becoming defects or changing policy', async () => setup(async ({ call, session, writer, origin, client, browser }) => {
  await call('browser_navigate', { url: origin });
  const first = json(await call('step_done', { step: 1, outcome: 'passed' }));
  const conflict = { step: 1, guidance_refs: [{ path: 'REVIEW.md', hash: 'a'.repeat(64), start_line: 1, end_line: 1 }],
    conflict: 'The journey accepts independent address entry while owner guidance requires reuse.',
    observed: 'The delivery address form is shown.', evidence: [first.evidence[0]] };
  const accepted = json(await call('report_expectation_conflict', conflict));
  assert.equal(accepted.status, 'unresolved');
  const invalid = structuredClone(conflict); invalid.guidance_refs[0].path = 'admin/REVIEW.md';
  assert.equal(json(await call('report_expectation_conflict', invalid)).dropped, 'invalid_guidance_citation');
  assert.equal(json(await call('report_expectation_conflict', { ...conflict, evidence: ['invented'] })).dropped, 'invalid_expectation_conflict');
  assert.ok((await client.callTool({ name: 'report_expectation_conflict', arguments: { ...conflict, publish: true, tokens: 999999 } })).isError);
  await call('step_done', { step: 2, outcome: 'passed' });
  const result = await session.finish();
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.hypotheses, []);
  assert.deepEqual(result.qa_recommendations, []);
  assert.equal(result.expectation_conflicts.length, 1);
  assert.deepEqual(result.expectation_conflicts[0].committed_step, journey.steps[0]);
  assert.equal(result.expectation_conflicts[0].journey_path, '.rio/qa/journeys/checkout.yaml');
  assert.ok(writer.notes.some(row => row.reason === 'unresolved_expectation' && row.id === accepted.conflict_id));
  const valid = validateContract(contract('qa-replay-v1'));
  for (const event of browser.replayEvents) assert.ok(valid(event), JSON.stringify(valid.errors));
}));

test('unavailable fixture captures retain independent browser evidence and report the gap', async () => setup(async ({ call, session, writer, origin }) => {
  session.capturedMessages = async () => { throw new Error('private backend detail'); };
  await call('browser_navigate', { url: origin });
  const result = json(await call('step_done', { step: 1, outcome: 'passed' }));
  assert.ok(result.evidence.some(id => writer.artifacts.find(artifact => artifact.id === id)?.kind === 'screenshot'));
  assert.ok(JSON.stringify(writer.notes).includes('capture_read_failed'));
  assert.ok(!JSON.stringify(writer.notes).includes('private backend detail'));
}));

for (const functionalOutcome of ['passed', 'failed']) test(`${functionalOutcome} checkout keeps recommendations separate, captures step evidence through MCP and validates immutable guidance`, { timeout: 60000 }, async () => setup(async ({ call, browser, writer, session, guidance, origin, client }) => {
  guidance[0].lines.push('Fabricated requirement');
  await call('browser_navigate', { url: origin });
  const snapshot = await call('browser_snapshot');
  const ref = /textbox.*?\[ref=(e\d+)\]/.exec(snapshot.content.map(row => row.text || '').join('\n'))?.[1];
  assert.ok(ref, JSON.stringify(snapshot));
  await call('browser_type', { target: ref, text: '12 Example Street' });
  const firstReply = await call('step_done', { step: 1, outcome: 'passed' });
  const first = json(firstReply);
  assert.equal(first.evidence.length, 6);
  const nextRef = /button "Continue".*?\[ref=(e\d+)\]/.exec(firstReply.content.map(row => row.text || '').join('\n'))?.[1];
  assert.ok(nextRef, 'step boundary must return fresh inline element references');
  await call('browser_click', { target: nextRef });
  await call('browser_type', { target: '#address', text: '12 Example Street' });
  await call('browser_click', { target: '#pay' });
  const second = json(await call('step_done', { step: 2, outcome: functionalOutcome }));
  const evidence = [first.evidence[0], second.evidence[0]], recommendation = advice(evidence);
  const accepted = json(await call('recommend', recommendation));
  assert.equal(accepted.verification_status, 'unverified');
  const invalid = structuredClone(recommendation); invalid.basis.guidance[0].end_line = 2;
  assert.equal(json(await call('recommend', invalid)).dropped, 'invalid_guidance_citation');
  assert.equal(json(await call('recommend', { ...recommendation, evidence: ['invented'] })).dropped, 'missing_or_invalid_recommendation_evidence');
  assert.ok((await client.callTool({ name: 'recommend', arguments: { ...recommendation, verification_status: 'supported' } })).isError);
  assert.ok((await client.callTool({ name: 'recommend', arguments: { ...recommendation, evidence: [] } })).isError);
  assert.equal(json(await call('observe', { rule_id: 'ui/no-feedback', kind: 'ux', expected: { text: 'Confirmation' }, observed: { text: 'Blank' }, evidence: ['invented'], suggested_fix: 'Show confirmation' })).dropped, 'missing_or_invalid_observation_evidence');
  await call('assess', { rule_id: 'ux/task-efficiency', status: 'assessed', evidence });
  const batch = json(await call('assess', { assessments: [
    { rule_id: 'ux/task-clarity', status: 'assessed', evidence },
    { rule_id: 'ux/error-recovery', status: 'not_assessed', evidence: [], reason: 'No recovery step in this journey' },
    { rule_id: 'ux/user-control', status: 'assessed', evidence: ['invented'] },
  ] }));
  assert.equal(batch.assessments[2].dropped, 'ungrounded_assessment');
  assert.ok((await client.callTool({ name: 'assess', arguments: { assessments: [] } })).isError);
  const result = await session.finish();
  assert.equal(result.outcome, functionalOutcome); assert.equal(result.qa_recommendations.length, 1); assert.equal(result.hypotheses.length, 0);
  assert.equal(result.ux_assessment.find(row => row.rule_id === 'ux/task-efficiency').status, 'assessed');
  assert.equal(result.ux_assessment.find(row => row.rule_id === 'ux/task-clarity').status, 'assessed');
  assert.ok(result.ux_assessment.some(row => row.status === 'not_assessed'));
  assert.equal(result.dropped.invalid_recommend_arguments, 2);
  assert.ok(session.prompt().includes('Reuse the delivery address'));
  assert.ok(!session.prompt().includes('Fabricated requirement'));
  assert.deepEqual(result.verification_context.journey, journey);
  assert.equal(result.verification_context.guidance[0].lines.length, 1);
  assert.ok(result.verification_context.criteria.some(rule => rule.id === 'ux/task-efficiency'));
  assert.ok(session.prompt().includes('not_assessed'));
  assert.ok(session.prompt().includes('Benefits of proposals are expected'));
  const valid = validateContract(contract('qa-replay-v1'));
  for (const [index, event] of browser.replayEvents.entries()) { assert.ok(valid(event), JSON.stringify(valid.errors)); assert.equal(event.sequence, index); }
  const typed = browser.replayEvents.find(event => event.action === 'type');
  assert.ok(!typed.arguments.selector.includes('aria-ref=')); assert.notEqual(typed.arguments.selector, ref);
  assert.equal(browser.replayEvents.filter(event => event.action === 'step_done').length, 2);
  assert.equal(writer.artifacts.filter(row => row.kind === 'screenshot').length, 3);
  assert.ok((await client.callTool({ name: 'step_done', arguments: { step: 2, outcome: 'passed' } })).isError);
}));

test('failed expectations name the first failing step; assessment gaps and active evidence survive a budget end', { timeout: 60000 }, async () => setup(async ({ call, session, writer, origin }) => {
  await call('browser_navigate', { url: origin });
  const first = json(await call('step_done', { step: 1, outcome: 'failed', reason: 'Saved address is missing' }));
  await call('browser_type', { target: '#address', text: 'Trying to recover' });
  const result = await session.finish({ reason: 'budget' });
  assert.equal(result.outcome, 'failed'); assert.equal(result.failed_step, 1); assert.deepEqual(result.evidence, first.evidence);
  assert.ok(result.ux_assessment.every(row => row.status === 'not_assessed' && row.reason === 'budget'));
  assert.equal(writer.artifacts.filter(row => row.kind === 'screenshot').length, 3);
  assert.deepEqual(await session.finish(), result);
}));

test('recorded targets replay without a harness; changed prerequisite is inconclusive and target non-recurrence never refutes', { timeout: 60000 }, async () => setup(async ({ call, browser, origin }) => {
  await call('browser_navigate', { url: origin });
  await call('browser_type', { target: '#address', text: '12 Example Street' });
  await call('step_done', { step: 1, outcome: 'passed' });
  await call('browser_click', { target: '#next' });
  await call('step_done', { step: 2, outcome: 'failed', reason: 'Address cleared and requested again' });
  const events = structuredClone(browser.replayEvents);
  for (const mode of ['recurs', 'broken-prerequisite', 'fixed']) {
    let replayBrowser, bridge, client, closed = false;
    const backend = {
      async start() {
        replayBrowser = await openBrowser({ viewport, allowedOrigins: [origin] });
        bridge = await restrictedMcp(replayBrowser, { allowedOrigins: [origin] }); client = await connect(bridge);
      },
      context: context => replayBrowser.controls.context(context),
      call: args => client.callTool(args),
      async capture(event) { return [`replay-${event.step}`]; },
      async prerequisite() { return mode !== 'broken-prerequisite' && await replayBrowser.page.locator('#address').inputValue() === '12 Example Street'; },
      async recurrence() { return mode !== 'fixed' && await replayBrowser.page.locator('#address').inputValue() === '' && await replayBrowser.page.locator('h1').textContent() === 'Billing'; },
      async close() { await client?.close(); await bridge?.close(); await replayBrowser?.close(); closed = true; },
    };
    const result = await executeReplay({ events, until: { journey: 'checkout', step: 2 }, backend, wallMs: 20000 });
    assert.equal(result.outcome, mode === 'recurs' ? 'recurred' : mode === 'fixed' ? 'not_recurred' : 'prerequisites_failed');
    assert.ok(closed); assert.ok(result.evidence.length);
  }
}));

test('budget exhaustion cannot claim a pass or satisfactory UX and retains the active step', { timeout: 60000 }, async () => setup(async ({ call, session, origin, writer }) => {
  await call('browser_navigate', { url: origin });
  const result = await session.finish({ reason: 'budget' });
  assert.equal(result.outcome, 'cancelled'); assert.equal(result.reason, 'budget');
  assert.ok(result.ux_assessment.every(row => row.status === 'not_assessed' && row.reason === 'budget'));
  assert.equal(result.evidence.length, 6); assert.equal(writer.artifacts.length, 7);
}));


test('observations retain before/after evidence and browser-derived targets without trusting model identity', async () => setup(async ({ call, session, origin }) => {
  await call('browser_navigate', { url: origin });
  const before = json(await call('step_done', { step: 1, outcome: 'passed' }));
  const after = json(await call('step_done', { step: 2, outcome: 'failed' }));
  const observation = { rule_id: 'ui/no-feedback', kind: 'ux', expected: { text: 'Confirmation' }, observed: { text: 'Blank' },
    evidence: [before.evidence[0], after.evidence[0]], suggested_fix: 'Show confirmation', element_paths: ['#pay'] };
  const first = json(await call('observe', observation));
  const second = json(await call('observe', { ...observation, expected: { status: 'Confirmed' }, observed: { status: 'Missing' }, element_paths: ['button[id="pay"]'] }));
  assert.equal(first.observation_id, second.observation_id);
  assert.deepEqual(session.hypotheses[0].targets, [{ tag: 'button', role: 'button', name: 'Pay', key: 'pay', ordinal: 0 }]);
  assert.deepEqual(session.hypotheses[0].evidence, observation.evidence);
  assert.equal(json(await call('observe', { ...observation, element_paths: ['#missing'] })).dropped, 'missing_observation_target');
}));


test('feedback observations bind the recorded action target despite different result selectors', async () => setup(async ({ browser, call, session, origin }) => {
  await call('browser_navigate', { url: origin });
  const boundary = await call('step_done', { step: 1, outcome: 'passed' });
  const ref = /button "Pay".*?\[ref=(e\d+)\]/.exec(boundary.content.map(row => row.text || '').join('\n'))?.[1];
  assert.ok(ref);
  await call('browser_click', { target: ref });
  await browser.page.locator('#pay').evaluate(el => el.remove());
  const after = json(await call('step_done', { step: 2, outcome: 'failed' }));
  const observation = { rule_id: 'ui/no-feedback', kind: 'ux', expected: { text: 'Confirmation' }, observed: { text: 'Blank' },
    evidence: [after.evidence[0]], suggested_fix: 'Show confirmation' };
  const page = json(await call('observe', observation));
  const region = json(await call('observe', { ...observation, observed: { status: 'No result' }, element_paths: ['h1'] }));
  assert.equal(page.observation_id, region.observation_id);
  const invalidHint = json(await call('observe', { ...observation, element_paths: ['role=region[name=Order result]'] }));
  assert.equal(page.observation_id, invalidHint.observation_id);
  assert.equal(session.hypotheses[0].targets[0].key, 'pay');
}));
