import test from 'node:test';
import assert from 'node:assert/strict';
import { responseRequest, anthropicRequest, cacheHints, providerTransport, BOUNDARY, OMITTED } from '../src/provider-transport.mjs';
import { dropStaleImages } from '../src/model-proxy.mjs';

// QA transport cache hints and shape-stable screenshot replacement (D16).
const prompt = `Execute the committed journey.\n{"criteria":[]}\n${BOUNDARY}\n{"journey":{"name":"checkout"},"cell":{"viewport":"mobile"}}`;
const png = n => `data:image/png;base64,${Buffer.from(`shot-${n}`).toString('base64')}`;
const tool = { type: 'function', name: 'step_done', parameters: { type: 'object', properties: {} } };
/** A Responses body after `turns` tool turns; `shots` lists the turns whose
 * tool result returned a screenshot. */
function conversation(turns, shots, extra = {}) {
  const input = [{ role: 'developer', content: [{ type: 'input_text', text: 'Harness instructions.' }] },
    { role: 'user', content: [{ type: 'input_text', text: prompt }] }];
  for (let t = 1; t <= turns; t++) {
    input.push({ type: 'function_call', call_id: `c${t}`, name: 'step_done', arguments: `{"step":${t}}` });
    input.push({ type: 'function_call_output', call_id: `c${t}`, output: shots.includes(t)
      ? [{ type: 'input_text', text: `Step ${t} recorded.` }, { type: 'input_image', image_url: png(t) }]
      : `Step ${t} recorded.` });
  }
  return { model: 'm', tools: [tool], input, ...extra };
}
/** The provider request the transport sends, after the proxy's replacement. */
function wire(body, protocol, cache) {
  const copy = structuredClone(body); dropStaleImages(copy);
  const { chat } = responseRequest(copy);
  return cacheHints(protocol === 'anthropic' ? anthropicRequest(chat) : chat, protocol, cache);
}
const BREAKPOINTS = { capability: 'breakpoints' };
/** System and message blocks in order, with their role; markers apart. */
function blocks(payload, protocol) {
  const strip = ({ cache_control, ...block }) => block;
  const out = [];
  if (protocol === 'anthropic') for (const b of payload.system) out.push({ role: 'system', block: b });
  for (const m of payload.messages) for (const b of Array.isArray(m.content) ? m.content : m.content == null ? [] : [{ type: 'text', text: m.content }]) out.push({ role: m.role, block: b });
  return out.map(({ role, block }) => ({ marked: !!block.cache_control, key: JSON.stringify({ role, block: strip(block) }) }));
}
const marks = list => list.flatMap((b, i) => b.marked ? [i] : []);
const sameUpTo = (a, b, p) => assert.deepEqual(a.slice(0, p + 1).map(x => x.key), b.slice(0, p + 1).map(x => x.key));
const joined = payload => JSON.stringify(payload.messages.map(m => Array.isArray(m.content) ? m.content.map(b => b.text ?? '').join('') : m.content));

test('a replaced screenshot keeps its message, position and text; only the image part changes', () => {
  const before = responseRequest(structuredClone(conversation(2, [2]))).chat.messages;
  const later = conversation(3, [2, 3]); dropStaleImages(later);
  const after = responseRequest(later).chat.messages;
  const replaced = before.map(m => !Array.isArray(m.content) ? m
    : { ...m, content: m.content.map(p => p.type === 'image_url' ? { type: 'text', text: OMITTED } : p) });
  assert.deepEqual(after.slice(0, before.length), replaced);
  // Byte for byte up to the replaced image.
  const a = JSON.stringify(before), b = JSON.stringify(after), at = a.indexOf('{"type":"image_url"');
  assert.equal(b.slice(0, at), a.slice(0, at));
  assert.equal(after[before.length - 1].content[0].text, 'Screenshots returned by the preceding tool results.');
});

test('first request of a journey: system, run-stable part and last block, with the harness text intact', () => {
  for (const protocol of ['anthropic', 'openai']) {
    const plain = wire(conversation(0, []), protocol, { capability: 'none' });
    const sent = wire(conversation(0, []), protocol, { capability: protocol === 'anthropic' ? 'breakpoints' : 'parts' });
    const list = blocks(sent, protocol);
    const user = sent.messages.find(m => m.role === 'user');
    assert.equal(user.content.map(b => b.text).join(''), prompt);
    assert.ok(user.content[1].text.startsWith(BOUNDARY));
    assert.ok(user.content[0].cache_control && user.content[1].cache_control, protocol);
    assert.equal(marks(list).length, 3, protocol);
    assert.equal(joined(sent).replaceAll('null', ''), joined(plain).replaceAll('null', ''));
  }
});

test('the boundary is split on every request, marked only without a replaced screenshot', () => {
  for (const [turns, shots] of [[0, []], [2, [1]], [3, [1, 3]]]) {
    const user = wire(conversation(turns, shots), 'anthropic', BREAKPOINTS).messages[0];
    assert.equal(user.content.length, 2);
    assert.equal(!!user.content[0].cache_control, turns < 3, `${turns} turns`);
  }
});

test('no boundary and no replaced screenshot: only system, newest-image and last-block markers', () => {
  const body = conversation(2, [2]); body.input[1].content[0].text = 'A prompt without the line.';
  const sent = wire(body, 'anthropic', BREAKPOINTS);
  const list = blocks(sent, 'anthropic');
  assert.equal(marks(list).length, 3);
  assert.ok(sent.system.at(-1).cache_control);
  const image = list.findLastIndex(b => b.key.includes('"type":"image"'));
  assert.deepEqual(marks(list).slice(1), [image - 1, list.length - 1]);
});

test('never more than four markers, never on an empty block, joined text unchanged', () => {
  for (let turns = 0; turns <= 30; turns++) {
    const body = conversation(turns, [1, 13, 25].filter(t => t <= turns));
    for (const [protocol, capability] of [['anthropic', 'breakpoints'], ['openai', 'parts']]) {
      const sent = wire(body, protocol, { capability });
      const list = blocks(sent, protocol);
      assert.ok(marks(list).length <= 4, `${turns} ${protocol}`);
      assert.ok(list.every(b => !b.marked || !b.key.includes('"text":""')));
      const plain = wire(body, protocol, { capability: 'none' });
      assert.equal(joined(sent).replaceAll('null', ''), joined(plain).replaceAll('null', ''));
    }
  }
});

test('an empty text block is never marked; its marker moves to the nearest earlier block with content', () => {
  for (const [protocol, capability] of [['anthropic', 'breakpoints'], ['openai', 'parts']]) {
    const body = conversation(2, [2]);
    body.input[0].content.push({ type: 'input_text', text: '' });
    body.input.at(-1).output.splice(1, 0, { type: 'input_text', text: '' });
    body.input.push({ role: 'user', content: [{ type: 'input_text', text: 'Next.' }, { type: 'input_text', text: '' }] });
    const list = blocks(wire(body, protocol, { capability }), protocol);
    assert.ok(list.some(b => b.key.includes('"text":""')), protocol);
    assert.ok(list.every(b => !b.marked || !b.key.includes('"text":""')), protocol);
    assert.ok(marks(list).length >= 3 && marks(list).length <= 4, protocol);
  }
});

test('a scripted conversation keeps every reuse at an earlier marker, beyond the 20-block lookback', () => {
  // Screenshots at turns 1, 13 and 25: 24 blocks between consecutive ones.
  const shots = [1, 13, 25], requests = [];
  for (let turns = 0; turns <= 30; turns++) requests.push(blocks(wire(conversation(turns, shots.filter(t => t <= turns)), 'anthropic', BREAKPOINTS), 'anthropic'));
  for (let k = 1; k < requests.length; k++) {
    const previous = requests[k - 1], current = requests[k];
    if (shots.includes(k) && k > shots[0]) {
      // The previous request's marker before its newest screenshot is where
      // this request marks the replaced one, with identical content before it.
      const image = previous.findLastIndex(b => b.key.includes('"type":"image"'));
      assert.ok(previous[image - 1].marked && current[image - 1].marked, `request ${k}`);
      sameUpTo(previous, current, image - 1);
    } else {
      // Otherwise this request extends the previous one through its last marker.
      sameUpTo(previous, current, previous.length - 1);
    }
  }
  // Request 25 reads the turn-13 entry: more than 20 blocks after it.
  const at25 = requests[25], placeholder = at25.findLastIndex(b => b.key.includes(OMITTED));
  assert.ok(at25[placeholder - 1].marked);
  assert.ok(at25.length - placeholder > 20);
});

test('OpenAI routes get Rio\'s key instead of the harness key; harness cache fields never pass', async () => {
  const sent = [];
  const fetch = async (_url, init) => { sent.push(JSON.parse(init.body)); return Response.json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }); };
  const body = { ...conversation(0, []), prompt_cache_key: 'harness-session', prompt_cache_retention: '24h' };
  await providerTransport({ url: 'https://api.openai.com/v1/chat/completions', headers: {}, model: 'gpt', cache: { capability: 'key', key: 'rio-key' }, fetch })({ path: '/v1/responses', body, signal: AbortSignal.timeout(1000) });
  await providerTransport({ url: 'https://api.openai.com/v1/chat/completions', headers: {}, model: 'gpt', fetch })({ path: '/v1/responses', body, signal: AbortSignal.timeout(1000) });
  assert.equal(sent[0].prompt_cache_key, 'rio-key');
  assert.equal(sent[1].prompt_cache_key, undefined);
  assert.ok(sent.every(b => b.prompt_cache_retention === undefined));
  assert.doesNotMatch(JSON.stringify(sent), /cache_control|harness-session/);
});
