import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayRecorder, executeReplay, replayCall } from '../src/replay.mjs';
import { contract, validateContract } from '../src/contracts.mjs';

const metadata = { journey: 'checkout', step: 1, cell: { viewport: 'mobile', color_scheme: 'light' } };
const event = (action, args, sequence = 0) => ({ version: 1, sequence, ...metadata, action, arguments: args });
const result = { content: [{ type: 'text', text: '{}' }] };
test('every exposed action has a closed, data-only replay representation', async () => {
  const browser = { replayEvents: [] }, recorder = new ReplayRecorder(browser, () => metadata);
  const calls = [
    ['browser_navigate', { url: 'http://app/' }], ['browser_navigate_back', {}], ['browser_snapshot', { depth: 2 }],
    ['browser_click', { target: '#pay', doubleClick: true, button: 'right', modifiers: ['Alt'] }], ['browser_hover', { target: '#pay' }],
    ['browser_type', { target: '#address', text: 'Test', slowly: true, submit: true }], ['browser_select_option', { target: 'select', values: ['x'] }],
    ['browser_press_key', { key: 'Enter' }], ['browser_wait_for', { time: 1, text: 'Ready', textGone: 'Loading' }],
    ['login', { persona: 'shopper' }], ['upload_fixture', { name: 'avatar' }], ['read_mail', { persona: 'shopper' }], ['read_sms', { persona: 'shopper' }],
    ['read_webhooks', { service: 'payments' }], ['set_service_behavior', { service: 'payments', behavior: 'decline' }],
    ['step_done', { step: 1, outcome: 'passed' }], ['observe', {}], ['assess', { rule_id: 'ux/task-efficiency' }], ['recommend', {}],
  ];
  const valid = validateContract(contract('qa-replay-v1'));
  for (const [tool, args] of calls) {
    const call = { tool, arguments: args, result }; call.state = await recorder.before(call); await recorder.after(call);
    const recorded = browser.replayEvents.at(-1); assert.ok(valid(recorded), JSON.stringify(valid.errors));
    const replay = replayCall(recorded);
    if (replay) { assert.equal(replay.name, tool); assert.deepEqual(replay.arguments, args); }
  }
  assert.equal(browser.replayEvents.length, calls.length);
  assert.ok(!valid(event('shell', { command: 'id' })));
  assert.ok(!valid(event('type', { selector: '#x', value: 'x', evaluate: 'process.exit()' })));
});

test('replay rejects corrupt sequences before startup, refuses redacted inputs and always tears down on timeout', async () => {
  let starts = 0, closes = 0;
  const backend = { start: async () => { starts++; }, close: async () => { closes++; }, call: async () => new Promise(() => {}) };
  const until = { journey: 'checkout', step: 1 }, done = event('step_done', { outcome: 'failed', evidence: [] }, 1);
  await assert.rejects(executeReplay({ events: [done], until, backend, wallMs: 100 }), /Invalid replay event sequence/); assert.equal(starts, 0);
  let replay = await executeReplay({ events: [event('type', { selector: '#x', value: '[redacted]' }), done], until, backend, wallMs: 100 });
  assert.equal(replay.outcome, 'prerequisites_failed'); assert.equal(replay.reason, 'redacted_input'); assert.equal(closes, 1);
  replay = await executeReplay({ events: [event('navigate', { url: 'http://app' }), done], until, backend, wallMs: 20 });
  assert.equal(replay.outcome, 'prerequisites_failed'); assert.equal(replay.reason, 'budget'); assert.equal(closes, 2);
});

test('captured links are rebound from the fresh capture without retaining verification tokens', async () => {
  const browser = { replayEvents: [] }, recorder = new ReplayRecorder(browser, () => metadata);
  const secretUrl = 'http://app/verify?token=old-private-token';
  const calls = [
    { tool: 'read_mail', arguments: { persona: 'shopper' }, result: { content: [{ type: 'text', text: JSON.stringify({ messages: [{ links: [secretUrl] }] }) }] } },
    { tool: 'browser_navigate', arguments: { url: secretUrl }, result },
    { tool: 'step_done', arguments: { step: 1, outcome: 'failed' }, result },
  ];
  for (const call of calls) { call.state = await recorder.before(call); await recorder.after(call); }
  assert.ok(!JSON.stringify(browser.replayEvents).includes('old-private-token'));
  assert.deepEqual(browser.replayEvents[1].arguments.capture, { sequence: 0, message: 0, link: 0 });
  let visited, closed = false;
  const backend = { start: async () => {}, close: async () => { closed = true; }, capture: async () => ['screenshot', 'dom'], recurrence: async () => true,
    call: async call => {
      if (call.name === 'read_mail') return { content: [{ type: 'text', text: JSON.stringify({ messages: [{ links: ['http://app/verify?token=new-private-token'] }] }) }] };
      visited = call.arguments.url; return result;
    } };
  const replay = await executeReplay({ events: browser.replayEvents, until: { journey: 'checkout', step: 1 }, backend, wallMs: 1000 });
  assert.equal(replay.outcome, 'recurred'); assert.equal(visited, 'http://app/verify?token=new-private-token'); assert.ok(closed);
  backend.call = async () => result;
  const missing = await executeReplay({ events: browser.replayEvents, until: { journey: 'checkout', step: 1 }, backend, wallMs: 1000 });
  assert.equal(missing.outcome, 'prerequisites_failed'); assert.equal(missing.reason, 'capture_binding_unavailable');
});
