import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JourneySession } from '../src/session.mjs';
import { Sanitizer } from '../src/sanitize.mjs';
import { BOUNDARY } from '../src/provider-transport.mjs';

// The journey prompt's layout (design D16). The pre-change prompts are the ones
// recorded with the harness captures before the partition and `qa-order`.
const captures = JSON.parse(readFileSync(new URL('./fixtures/harness-captures.json', import.meta.url)));
const journeys = [
  { name: 'checkout', persona: 'shopper', steps: [{ action: 'Open the cart', expect: 'The cart lists the item' }], success: 'An order is placed', ux_criteria: [] },
  { name: 'signup', persona: 'visitor', steps: [{ action: 'Open sign up', expect: 'A form asks for an email' }], success: 'An account exists', ux_criteria: [] },
];
const cells = [{ viewport: 'mobile', color_scheme: 'light' }, { viewport: 'desktop', color_scheme: 'dark' }];
const criteria = new Map([['ui/no-feedback', { id: 'ui/no-feedback', kind: 'judged', description: 'Actions give feedback.' }]]);
const origins = ['http://127.0.0.1:3000'];
const partition = 'a'.repeat(32);
const prompt = (journey, cell, options = {}) => JourneySession.prototype.prompt.call({
  writer: { sanitizer: new Sanitizer() }, journey, cell, guidance: options.guidance || [], criteria,
  partition: options.partition, order: options.order === true, sharedGuidance: options.shared !== false,
}, origins);
const element = `\n<review_partition id="${partition}"/>`;
const before = text => text.slice(0, text.indexOf(BOUNDARY));

test('with qa-order off the prompt is the pre-change text, plus only the partition on hosted runs', () => {
  for (const [c, cell] of cells.entries()) for (const journey of journeys) {
    const recorded = captures[`CodexHarness/cell${c}/${journey.name}`].prompt;
    assert.equal(prompt(journey, cell), recorded);
    const hosted = prompt(journey, cell, { partition });
    assert.equal(hosted.replace(element, ''), recorded);
    // After the instructions, immediately before the first data.
    assert.ok(hosted.includes(`with a reason.${element}\n{"journey":`));
    assert.ok(!hosted.includes(BOUNDARY));
  }
});

test('with qa-order the journeys of a run share everything through the boundary', () => {
  const [a, b] = journeys.map(journey => prompt(journey, cells[0], { partition, order: true }));
  assert.equal(before(a), before(b));
  assert.notEqual(a, b);
  assert.ok(before(a).includes(element) && before(a).includes('Application origins:') && before(a).includes('"criteria"'));
  assert.ok(!before(a).includes('"journey"') && !before(a).includes('"cell"'));
  // One journey in two cells differs only after the boundary.
  const [mobile, desktop] = cells.map(cell => prompt(journeys[0], cell, { partition, order: true }));
  assert.equal(before(mobile), before(desktop));
  assert.notEqual(mobile, desktop);
  // Only the order changes: the same data, the same instructions.
  assert.equal(a.split(BOUNDARY).length, 2);
});

test('guidance that differs between journeys stays after the boundary; a local run has no partition', () => {
  const guidance = [{ path: 'QA.md', lines: ['Checkout keeps the address.'] }];
  const shared = prompt(journeys[0], cells[0], { order: true, guidance });
  const own = prompt(journeys[0], cells[0], { order: true, guidance, shared: false });
  assert.ok(before(shared).includes('Checkout keeps the address.'));
  assert.ok(!before(own).includes('Checkout keeps the address.'));
  assert.ok(own.slice(own.indexOf(BOUNDARY)).includes('Checkout keeps the address.'));
  for (const text of [shared, own, prompt(journeys[0], cells[0])]) assert.doesNotMatch(text, /review_partition/);
});
