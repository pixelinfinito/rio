import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { responseResult, providerTransport } from '../src/provider-transport.mjs';

// The Worker's documented usage fixtures (anthropic, openai, openrouter).
const fixtures = JSON.parse(readFileSync(new URL('../../../../worker/tests/fixtures/usage/usage.json', import.meta.url)));
const protocolOf = source => source === 'anthropic' ? 'anthropic' : 'openai';
const conventionOf = source => source === 'openrouter' ? 'unverified' : 'verified';
const reply = (protocol, usage) => protocol === 'anthropic'
  ? { content: [{ type: 'text', text: 'ok' }], usage }
  : { choices: [{ message: { content: 'ok' } }], usage };

test('QA transport reports total input and real cached tokens for every usage fixture', () => {
  for (const c of fixtures.cases) {
    const protocol = protocolOf(c.source), convention = conventionOf(c.source);
    if (c.error) {
      assert.throws(() => responseResult(reply(protocol, c.usage), new Map(), 'm', protocol, convention), { message: c.error }, c.name);
      continue;
    }
    const { usage } = responseResult(reply(protocol, c.usage), new Map(), 'm', protocol, convention);
    assert.equal(usage.input_tokens, c.expected.input_tokens, c.name);
    assert.equal(usage.output_tokens, c.expected.output_tokens, c.name);
    assert.equal(usage.total_tokens, c.expected.input_tokens + c.expected.output_tokens, c.name);
    assert.equal(usage.input_tokens_details.cached_tokens, c.expected.cache_read_input_tokens ?? 0, c.name);
  }
});

test('an Anthropic cache read reaches the harness as total input and cached tokens', () => {
  const { usage } = responseResult(reply('anthropic', { input_tokens: 50, cache_read_input_tokens: 100000, output_tokens: 300 }), new Map(), 'm', 'anthropic', 'verified');
  assert.deepEqual([usage.input_tokens, usage.input_tokens_details.cached_tokens, usage.total_tokens], [100050, 100000, 100350]);
});

test('OpenAI cached tokens reach the harness instead of 0', () => {
  const { usage } = responseResult(reply('openai', { prompt_tokens: 12000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 10240 } }), new Map(), 'm', 'openai', 'verified');
  assert.equal(usage.input_tokens_details.cached_tokens, 10240);
  assert.equal(usage.input_tokens, 12000);
});

test('a reply without usage still has no usage, and the observer sees the normalized usage once', async () => {
  assert.equal(responseResult(reply('openai', undefined), new Map(), 'm', 'openai', 'verified').usage, undefined);
  const seen = [];
  const forward = providerTransport({ url: 'https://api.example/v1', headers: {}, model: 'x', convention: 'verified',
    usage: (usage, cost) => seen.push({ usage, cost }),
    fetch: async () => Response.json(reply('openai', { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 }, cost: 0.01 })) });
  await forward({ path: '/v1/responses', body: { model: 'm', input: 'hi' }, signal: AbortSignal.timeout(1000) });
  assert.deepEqual(seen, [{ usage: { input_tokens: 100, cache_read_input_tokens: 64, cache_write_input_tokens: null, output_tokens: 5, usage_convention: 'verified' }, cost: 0.01 }]);
});
