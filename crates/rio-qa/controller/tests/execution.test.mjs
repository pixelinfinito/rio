import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executePlan, aggregateJourney, HarnessCrash } from '../src/execution.mjs';
const cells = ['mobile', 'desktop'].flatMap(viewport => ['light', 'dark'].map(color_scheme => ({ viewport, color_scheme })));
const journeys = {
  cart: { name: 'cart', resets: true, after: [] },
  checkout: { name: 'checkout', after: ['cart'] },
  registration: { name: 'registration', resets: true, after: [] },
};
function fixture() {
  const events = []; let state;
  return {
    events,
    async restoreSeed({ cell }) { events.push(['restore', cell]); state = { cart: [], users: [] }; },
    async applyCredentials() { events.push(['credentials']); },
    async resetServiceBehaviors() { events.push(['services']); },
    async openCell() { events.push(['context']); return {}; },
    async closeCell() { events.push(['close']); },
    async runJourney({ journey, cell }) {
      events.push(['journey', journey.name, cell]);
      if (journey.name === 'cart') state.cart.push('item');
      if (journey.name === 'checkout') { assert.deepEqual(state.cart, ['item']); state.cart = []; }
      if (journey.name === 'registration') { assert.deepEqual(state.users, []); state.users.push('new@example.test'); }
      return { outcome: 'passed', evidence: [`${journey.name}/${cell.viewport}/step-1.png`] };
    },
  };
}
test('seed resets at chain heads in each cell; checkout retains the cart', async () => {
  const backend = fixture();
  const result = await executePlan({ plan: { chains: [{ journeys: ['cart', 'checkout'] }, { journeys: ['registration'] }], cells }, journeys, backend, runWallMs: 10000, cellWallMs: 1000 });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.journey_outcomes.length, 12);
  assert.equal(backend.events.filter(event => event[0] === 'restore').length, 8);
  assert.equal(backend.events.filter(event => event[0] === 'credentials').length, 8);
  assert.deepEqual(backend.events.slice(0, 7).map(event => event[0]), ['restore', 'credentials', 'services', 'context', 'journey', 'journey', 'close']);
  assert.equal(aggregateJourney(result.journey_outcomes), 'passed');
});
test('narrower dependent matrix preserves cart state without expanding its override', async () => {
  const backend = fixture();
  const narrowed = { ...journeys, checkout: { ...journeys.checkout, viewports: ['mobile'] } };
  const result = await executePlan({ plan: { chains: [{ journeys: ['cart', 'checkout'] }], cells }, journeys: narrowed, backend, runWallMs: 10000, cellWallMs: 1000 });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.journey_outcomes.length, 6);
  assert.deepEqual(result.journey_outcomes.filter(row => row.journey === 'checkout').map(row => row.cell), cells.filter(cell => cell.viewport === 'mobile'));
  assert.equal(backend.events.filter(event => event[0] === 'restore').length, 4);
  assert.ok(result.journey_outcomes.every(row => row.outcome === 'passed'));
});
test('harness crash retries exactly once from restored seed', async () => {
  const backend = fixture(); let attempts = 0;
  backend.runJourney = async () => { attempts++; throw new HarnessCrash('unexpected exit'); };
  const result = await executePlan({ plan: { chains: [{ journeys: ['cart', 'checkout'] }], cells: [cells[0]] }, journeys, backend, runWallMs: 10000, cellWallMs: 1000 });
  assert.equal(attempts, 2);
  assert.equal(backend.events.filter(event => event[0] === 'restore').length, 2);
  assert.equal(backend.events.filter(event => event[0] === 'close').length, 2);
  assert.ok(result.journey_outcomes.every(result => result.reason === 'harness_error'));
});
test('interruption preserves finished results and cancels remaining cells', async () => {
  const backend = fixture(); const abort = new AbortController(); const run = backend.runJourney;
  backend.runJourney = async args => { const result = await run(args); if (args.journey.name === 'cart') abort.abort(); return result; };
  const result = await executePlan({ plan: { chains: [{ journeys: ['cart', 'checkout'] }], cells }, journeys, backend, runWallMs: 10000, cellWallMs: 1000, signal: abort.signal });
  assert.equal(result.outcome, 'partial');
  assert.equal(result.journey_outcomes.length, 8);
  assert.ok(result.journey_outcomes.some(result => result.reason === 'interrupted'));
  assert.equal(backend.events.filter(event => event[0] === 'close').length, 1);
  assert.equal(result.cell_metrics.length, 1, 'Unstarted cells have no measured runtime');
});

test('completed cell metrics are checkpointed even when a later cleanup fails', async () => {
  const backend = fixture(), retained = [];
  let closed = 0;
  backend.recordCellMetric = async metric => retained.push(structuredClone(metric));
  backend.closeCell = async () => { if (++closed === 2) throw new Error('cleanup failed'); };
  await assert.rejects(executePlan({ plan: { chains: [{ journeys: ['cart', 'checkout'] }], cells }, journeys, backend,
    runWallMs: 10000, cellWallMs: 1000 }), /cleanup failed/);
  assert.equal(retained.length, 2);
  assert.deepEqual(retained.map(row => row.cell), cells.slice(0, 2));
  assert.ok(retained.every(row => row.wall_time_ms >= 0 && row.journeys.length === 2));
});
test('mobile failure cannot be hidden by desktop passes', () => {
  assert.equal(aggregateJourney([{ outcome: 'failed' }, { outcome: 'passed' }]), 'failed');
  assert.equal(aggregateJourney([{ outcome: 'cancelled' }, { outcome: 'passed' }]), 'cancelled');
});

test('an unavailable prerequisite skips dependents while an unrelated chain still runs', async () => {
  const backend = fixture(), run = backend.runJourney;
  backend.runJourney = async args => args.journey.name === 'cart'
    ? { outcome: 'skipped', reason: 'precondition_failed', evidence: ['tls-network', 'screenshot'] } : run(args);
  const result = await executePlan({ plan: { chains: [{ journeys: ['cart', 'checkout'] }, { journeys: ['registration'] }], cells: [cells[0]] }, journeys, backend, runWallMs: 10000, cellWallMs: 1000 });
  assert.deepEqual(result.journey_outcomes.map(row => row.outcome), ['skipped', 'skipped', 'passed']);
  assert.equal(result.journey_outcomes[1].reason, 'precondition_failed');
  assert.deepEqual(result.journey_outcomes[0].evidence, ['tls-network', 'screenshot']);
  assert.ok(!backend.events.some(event => event[0] === 'journey' && event[1] === 'checkout'));
});

test('incompatible chain clocks fail before any backend operation', async () => {
  const backend = fixture();
  const invalid = { ...journeys, cart: { ...journeys.cart, context: { time: '2026-01-01T00:00:00Z' } } };
  await assert.rejects(executePlan({ plan: { chains: [{ journeys: ['cart', 'checkout'] }], cells }, journeys: invalid, backend, runWallMs: 10000, cellWallMs: 1000 }), /Incompatible chain times/);
  assert.deepEqual(backend.events, []);
});

test('resolved chain time reaches app and browser once while dependents retain state', async () => {
  const backend = fixture(), resets = [], browserContexts = [], changes = [];
  const restore = backend.restoreSeed, run = backend.runJourney;
  backend.restoreSeed = async args => { resets.push(args.context); await restore(args); };
  backend.openCell = async args => { browserContexts.push(args.context); return { controls: { context: async value => changes.push(value) } }; };
  backend.runJourney = async args => { assert.ok(args.context.time); return run(args); };
  const configured = { ...journeys, checkout: { ...journeys.checkout, context: { time: '2027-01-01T00:59:00+01:00', network: 'offline' } } };
  const result = await executePlan({ plan: { chains: [{ journeys: ['cart', 'checkout'] }], cells: [cells[0]] }, journeys: configured, defaults: { time: '2026-12-31T23:59:00Z' }, backend, runWallMs: 10000, cellWallMs: 1000 });
  assert.equal(result.outcome, 'complete');
  assert.equal(resets.length, 1); assert.deepEqual(browserContexts, resets);
  assert.equal(changes.length, 2); assert.equal(changes[1].network, 'offline');
  assert.equal(resets[0].time, '2026-12-31T23:59:00Z');
});

test('model token exhaustion cancels the rest of a cell without crash retry or dependent skips', async () => {
  const backend = fixture(); let attempts = 0;
  backend.runJourney = async () => { attempts++; return { outcome: 'cancelled', reason: 'budget', evidence: ['retained'] }; };
  const result = await executePlan({ plan: { chains: [{ journeys: ['cart', 'checkout'] }], cells: [cells[0]] }, journeys, backend, runWallMs: 10000, cellWallMs: 1000 });
  assert.equal(result.outcome, 'partial'); assert.equal(attempts, 1);
  assert.equal(backend.events.filter(event => event[0] === 'restore').length, 1);
  assert.ok(result.journey_outcomes.every(outcome => outcome.outcome === 'cancelled' && outcome.reason === 'budget'));
  assert.deepEqual(result.journey_outcomes[0].evidence, ['retained']);
});
