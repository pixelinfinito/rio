import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { responseRequest } from '../src/provider-transport.mjs';

// Codex and pi request bodies recorded through the controller proxy for two
// journeys in two cells (`tests/capture-harness.mjs`, prompt-caching task 10.2).
// The findings are listed in docs/evaluation/prompt-caching.md.
const captures = JSON.parse(readFileSync(new URL('./fixtures/harness-captures.json', import.meta.url)));
const runs = harness => Object.entries(captures).filter(([key]) => key.startsWith(harness)).map(([, value]) => value);
const wire = body => JSON.stringify(responseRequest(body).chat);
const diverge = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };

test('captures cover both harnesses, two journeys and two cells, each with a tool follow-up', () => {
  assert.equal(Object.keys(captures).length, 8);
  for (const run of Object.values(captures)) {
    assert.equal(run.status, 'completed');
    const [first, second] = run.bodies;
    // Within a journey the harness appends; the second request extends the first.
    assert.deepEqual(second.input.slice(0, first.input.length), first.input);
  }
});

test('session ids, message ids and the harness prompt_cache_key never reach the provider', () => {
  for (const run of Object.values(captures)) {
    const body = run.bodies[0], sent = wire(body);
    assert.ok(body.prompt_cache_key);
    assert.doesNotMatch(sent, /prompt_cache_key|client_metadata|installation_id|msg_/);
    assert.doesNotMatch(sent, new RegExp(body.prompt_cache_key));
  }
});

test('the per-run private directory makes journeys diverge before Rio\'s prompt', () => {
  for (const harness of ['CodexHarness', 'PiHarness']) {
    const [a, b] = runs(harness).map(run => wire(run.bodies[0]));
    const at = diverge(a, b);
    assert.ok(at < a.indexOf('Execute the committed journey'), harness);
    assert.match(a.slice(at - 40, at + 40), /rio-private-harness-/, harness);
  }
  // pi states the date and directory at the end of its system prompt; Codex in
  // its skill roots and environment context.
  const pi = runs('PiHarness')[0].bodies[0].input[0].content;
  assert.match(pi, /Current date: \d{4}-\d\d-\d\d\nCurrent working directory: \/tmp\/rio-private-harness-\w+$/);
  const codex = JSON.stringify(runs('CodexHarness')[0].bodies[0].input.slice(0, 3));
  assert.match(codex, /<current_date>\d{4}-\d\d-\d\d<\/current_date>/);
  assert.match(codex, /<cwd>\/tmp\/rio-private-harness-\w+<\/cwd>/);
});
