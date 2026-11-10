import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SetupAuthor, runSetupAuthor } from '../src/setup-author.mjs';
import { Sanitizer } from '../src/sanitize.mjs';
import { EvidenceWriter } from '../src/evidence.mjs';

async function connect(bridge) {
  const [a, b] = InMemoryTransport.createLinkedPair(); await bridge.server.connect(b);
  const client = new Client({ name: 'scripted-setup', version: '1' }); await client.connect(a); return client;
}
test('setup exposes only a proposal tool and rejects paths, credentials, duplicate and existing files', async () => {
  const author = new SetupAuthor({ input: { stage: 'definitions', existing_definition_paths: ['.rio/qa/seed/existing.sql'] }, sanitizer: new Sanitizer(['private-persona-secret']) });
  const client = await connect(author);
  try {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['propose_setup']);
    for (const path of ['src/app.ts', '../outside', '.rio/qa/seed/../../outside', '.rio/qa/seed/.cache/db', '.rio/qa/seed/existing.sql']) {
      assert.ok((await client.callTool({ name: 'propose_setup', arguments: { files: [{ path, content: 'synthetic' }] } })).isError, path);
    }
    const file = { path: '.rio/qa/seed/rows.sql', content: 'SELECT 1;' };
    assert.ok((await client.callTool({ name: 'propose_setup', arguments: { files: [file, file] } })).isError);
    assert.ok((await client.callTool({ name: 'propose_setup', arguments: { files: [{ ...file, content: 'private-persona-secret' }] } })).isError);
    assert.ok((await client.callTool({ name: 'propose_setup', arguments: { files: [file], budget: 99999 } })).isError);
    assert.ok(!(await client.callTool({ name: 'propose_setup', arguments: { files: [file] } })).isError);
    assert.deepEqual(author.proposal, { files: [file] });
  } finally { await client.close(); await author.close(); }
});
test('setup completes without starting application/browser and retains bounded evidence', async () => {
  const objects = new Map();
  const writer = new EvidenceWriter({ sink: { put: async (key, bytes) => { objects.set(key, bytes); return { storage: 'local', link: key }; }, manifest: async () => {} } });
  const proposal = { files: [{ path: '.rio/qa.yaml', content: '{"version":1}' }] };
  let checkpoint;
  const result = await runSetupAuthor({ setup: { stage: 'contract' }, writer, budget: { tokens: 50000, wall_ms: 5000 }, auth: 'subscription', harness: 'codex', model: 'stub',
    checkpoint: async value => { checkpoint = value; }, harnessFactory: () => ({ run: async ({ bridge, prompt }) => {
      assert.ok(prompt.includes('requires developer confirmation'));
      const client = await connect(bridge);
      try { assert.ok(!(await client.callTool({ name: 'propose_setup', arguments: proposal })).isError); }
      finally { await client.close(); }
      return { status: 'completed' };
    } }) });
  assert.equal(result.outcome, 'complete'); assert.deepEqual(result.proposal, proposal);
  assert.equal(checkpoint.outcome, 'complete'); assert.ok(objects.size);
});
test('a failed or empty setup turn cannot publish a proposal', async () => {
  for (const failure of [true, false]) {
    const writer = new EvidenceWriter({ sink: { put: async key => ({ storage: 'local', link: key }), manifest: async () => {} } });
    const result = await runSetupAuthor({ setup: { stage: 'definitions' }, writer, budget: { tokens: 50000, wall_ms: 5000 }, auth: 'subscription', harness: 'codex', model: 'stub',
      harnessFactory: () => ({ run: async () => { if (failure) throw new Error('Harness failed'); return { status: 'completed' }; } }) });
    assert.equal(result.outcome, 'partial'); assert.equal(result.proposal, undefined);
  }
});
