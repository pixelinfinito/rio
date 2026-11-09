/** Trusted transport used on the host or Worker, never in the harness. Accepts
 * Responses requests from either CLI and adapts function calls to providers
 * whose endpoint speaks Chat Completions or Anthropic Messages. Provider-side
 * tools, remote image fetches and stored conversations are not admitted. */
const fail = () => { throw new Error('Unsupported QA model request'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function responseRequest(body) {
  if (!object(body) || body.previous_response_id || body.conversation || body.background || body.store === true) fail();
  const functions = [], names = new Map();
  const add = (tool, namespace) => {
    if (tool?.type === 'namespace' && !namespace && Array.isArray(tool.tools)) { for (const child of tool.tools) add(child, tool.name); return; }
    if (tool?.type !== 'function' || typeof tool.name !== 'string') fail();
    // Opaque aliases avoid collisions between namespaces and provider limits
    // on function-name length. Every returned call must resolve to this map.
    const name = `rio_tool_${functions.length}`;
    names.set(name, { name: tool.name, ...(namespace ? { namespace } : {}) });
    functions.push({ type: 'function', function: { name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} }, ...(tool.strict === undefined ? {} : { strict: tool.strict }) } });
  };
  if (body.tools !== undefined && !Array.isArray(body.tools)) fail();
  for (const tool of body.tools || []) add(tool);
  const alias = (name, namespace) => [...names].find(([, definition]) => definition.name === name && definition.namespace === namespace)?.[0] || fail();
  const content = value => {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) fail();
    return value.map(part => {
      if (['input_text', 'output_text', 'text'].includes(part.type) && typeof part.text === 'string') return { type: 'text', text: part.text };
      if (part.type === 'input_image' && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(part.image_url)) return { type: 'image_url', image_url: { url: part.image_url, detail: part.detail || 'auto' } };
      fail();
    });
  };
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  if (!Array.isArray(input)) fail();
  for (const item of input) {
    if (item.type === 'reasoning') continue; // Provider-specific opaque thinking is not a user message.
    if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.arguments !== 'string') fail();
      const call = { id: item.call_id, type: 'function', function: { name: alias(item.name, item.namespace), arguments: item.arguments } };
      const previous = messages.at(-1);
      if (previous?.role === 'assistant' && previous.tool_calls) previous.tool_calls.push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (item.type === 'function_call_output') {
      if (typeof item.call_id !== 'string') fail();
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: content(item.output) });
    } else if ((!item.type || item.type === 'message') && ['system', 'developer', 'user', 'assistant'].includes(item.role)) messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: content(item.content) });
    else fail();
  }
  let tool_choice;
  if (body.tool_choice !== undefined) {
    if (['auto', 'none', 'required'].includes(body.tool_choice)) tool_choice = body.tool_choice;
    else if (body.tool_choice?.type === 'function') tool_choice = { type: 'function', function: { name: alias(body.tool_choice.name, body.tool_choice.namespace) } };
    else fail();
  }
  return { names, chat: { model: body.model, messages, max_completion_tokens: body.max_output_tokens, stream: false,
    ...(functions.length ? { tools: functions, ...(tool_choice ? { tool_choice } : {}) } : {}),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }) } };
}

export function anthropicRequest(chat) {
  const messages = [], system = [];
  const content = value => typeof value === 'string' ? [{ type: 'text', text: value }] : (value || []).map(part => {
    if (part.type === 'text') return part;
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/=]+)$/.exec(part.image_url?.url || '');
    if (!match) fail();
    return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
  });
  for (const message of chat.messages) {
    if (['system', 'developer'].includes(message.role)) { system.push(...content(message.content)); continue; }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks = message.role === 'tool' ? [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: content(message.content) }] : content(message.content);
    for (const call of message.tool_calls || []) blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) });
    if (!blocks.length) continue;
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...blocks); else messages.push({ role, content: blocks });
  }
  let tool_choice;
  if (chat.tool_choice === 'required') tool_choice = { type: 'any' };
  else if (chat.tool_choice === 'auto') tool_choice = { type: 'auto' };
  else if (chat.tool_choice === 'none') tool_choice = { type: 'none' };
  else if (chat.tool_choice?.function) tool_choice = { type: 'tool', name: chat.tool_choice.function.name };
  return { model: chat.model, messages, system, max_tokens: chat.max_completion_tokens ?? chat.max_tokens, stream: false,
    ...(chat.tools?.length ? { tools: chat.tools.map(tool => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })), ...(tool_choice ? { tool_choice } : {}) } : {}) };
}

export function responseResult(result, names, model, protocol) {
  const output = [], usage = result.usage;
  const message = protocol === 'anthropic' ? {
    content: result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n'),
    tool_calls: result.content?.filter(part => part.type === 'tool_use').map(part => ({ id: part.id, function: { name: part.name, arguments: JSON.stringify(part.input) } })),
  } : result.choices?.[0]?.message;
  if (!message) throw new Error('Invalid QA provider response');
  if (message.content) output.push({ type: 'message', id: `msg_${crypto.randomUUID()}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: message.content, annotations: [] }] });
  for (const call of message.tool_calls || []) {
    const name = names.get(call.function?.name);
    if (!name || typeof call.function.arguments !== 'string') throw new Error('Provider returned an unknown QA tool');
    output.push({ type: 'function_call', id: `fc_${crypto.randomUUID()}`, call_id: call.id, ...name, arguments: call.function.arguments, status: 'completed' });
  }
  const input = usage?.input_tokens ?? usage?.prompt_tokens, completion = usage?.output_tokens ?? usage?.completion_tokens;
  const valid = [input, completion].every(n => Number.isSafeInteger(n) && n >= 0) && Number.isSafeInteger(input + completion);
  const incomplete = result.stop_reason === 'max_tokens' || result.choices?.[0]?.finish_reason === 'length';
  return { id: `resp_${crypto.randomUUID()}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: incomplete ? 'incomplete' : 'completed',
    output, ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    ...(valid ? { usage: { input_tokens: input, output_tokens: completion, total_tokens: input + completion,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens || 0 } } } : {}) };
}

export function responseStream(result) {
  const events = [], send = event => events.push(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: events.length })}\n\n`);
  send({ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } });
  for (const [index, item] of result.output.entries()) {
    send({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } });
    if (item.type === 'function_call') {
      send({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: item.arguments });
      send({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: index, arguments: item.arguments });
    } else for (const [content_index, part] of item.content.entries()) {
      send({ type: 'response.content_part.added', item_id: item.id, output_index: index, content_index, part: { ...part, text: '' } });
      send({ type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index, delta: part.text });
      send({ type: 'response.output_text.done', item_id: item.id, output_index: index, content_index, text: part.text });
      send({ type: 'response.content_part.done', item_id: item.id, output_index: index, content_index, part });
    }
    send({ type: 'response.output_item.done', output_index: index, item });
  }
  send({ type: `response.${result.status}`, response: result });
  return events.join('');
}

export async function boundedJson(response, limit = 32 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.byteLength; if (size > limit) throw new Error('QA provider response too large'); chunks.push(chunk); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** `url` is the complete operator-selected endpoint. No request field can
 * override destination, provider model, headers or transport permissions. */
export function providerTransport({ url, headers, model, protocol = 'openai', fetch: request = globalThis.fetch }) {
  const parsed = new URL(url);
  if (!['openai', 'anthropic'].includes(protocol) || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname))) || parsed.username || parsed.password || parsed.hash || parsed.search) throw new Error('Invalid QA provider route');
  return async ({ path, body, signal }) => {
    if (path !== '/v1/responses') throw new Error('QA provider adapter requires Responses');
    const { chat, names } = responseRequest(body); chat.model = model;
    const response = await request(parsed, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      // Workers rejects redirect:"error". Manual mode also prevents forwarding
      // credentials, and the non-2xx guard below refuses every redirect.
      body: JSON.stringify(protocol === 'anthropic' ? anthropicRequest(chat) : chat), signal, redirect: 'manual' });
    if (!response.ok) { await response.body?.cancel(); return new Response(null, { status: response.status }); }
    const result = responseResult(await boundedJson(response), names, body.model, protocol);
    return body.stream ? new Response(responseStream(result), { headers: { 'content-type': 'text/event-stream' } }) : Response.json(result);
  };
}
