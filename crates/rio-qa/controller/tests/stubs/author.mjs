#!/usr/bin/env node
// Scripted author for the Docker/CLI integration test. Never contacts a model.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const setup = prompt.split('\n').find(line => line.startsWith('{"setup":'));
const input = setup ? JSON.parse(setup) : JSON.parse(prompt.split('\n').find(line => line.startsWith('{"context":')));
const origins = setup ? [] : JSON.parse(prompt.split('Application origins: ').at(-1));
const endpoint = JSON.parse(process.argv.find(arg => arg.startsWith('mcp_servers.rio.url=')).slice('mcp_servers.rio.url='.length));
const client = new Client({ name: 'scripted-author', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { authorization: `Bearer ${process.env.RIO_QA_MCP_TOKEN}` } } }));
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};
try {
  const tools = (await client.listTools()).tools;
  if (tools.some(tool => /shell|evaluate|write_file|run_code/.test(tool.name))) throw new Error('Unexpected tool');
  if (setup) {
    if (tools.length !== 1 || tools[0].name !== 'propose_setup') throw new Error('Setup has excess capabilities');
    const existing = input.setup.existing_definition_paths || [];
    const files = [];
    if (input.setup.stage === 'contract') {
      files.push({ path: '.rio/qa.yaml', content: JSON.stringify({ version: 1,
        app: { packaging: 'static', directory: 'public', url: 'http://app.test:4173', ready: { path: '/', status: 200 }, routes_from: { map: [{ glob: 'src/checkout/**', route: '/checkout' }] } },
        personas: [{ name: 'shopper', description: 'Synthetic shopper' }], harness: { auth: 'subscription' } }) });
    } else if (input.setup.stage === 'dependencies') {
      if (JSON.stringify(input.setup.missing_dependencies) !== JSON.stringify(['catalog.example.test'])) throw new Error('Wrong discovered hosts: ' + JSON.stringify(input.setup.missing_dependencies));
      const fixtures = structuredClone(input.setup.existing_fixtures);
      (fixtures.services ||= []).push({ name: 'catalog', kind: 'http-mock', claims: ['catalog.example.test'], env: {}, recordings: 'recordings/catalog', behaviors: ['available'], default_behavior: 'available' });
      files.push({ path: '.rio/qa/fixtures/fixtures.yaml', content: JSON.stringify(fixtures) });
      files.push({ path: '.rio/qa/fixtures/recordings/catalog/available.json', content: JSON.stringify({ behavior: 'available', request: { method: 'GET', path: '/v1/catalog' }, response: { status: 200, body: { ready: true, products: [] } } }) });
    } else {
      if (!existing.includes('.rio/qa/seed/seed.yaml')) {
        if (!input.setup.schema_models.some(row => row.declarations.includes('model User')) || !input.setup.dependencies.includes('sdk:stripe')) throw new Error('Missing immutable schema/SDK metadata');
        files.push({ path: '.rio/qa/seed/seed.yaml', content: JSON.stringify({ version: 1,
          datastores: [{ name: 'records', kind: 'custom', capture: 'cat data/accounts.json', restore: 'mkdir -p data; cat > data/accounts.json' }],
          steps: [{ command: 'node .rio/qa/seed/accounts.mjs seed', applies_to: ['records'] }],
          users: input.setup.contract.personas.filter(row => row.password_env).map(row => ({ persona: row.name, apply: 'node .rio/qa/seed/accounts.mjs ' + row.name })), paths: [] }) });
        files.push({ path: '.rio/qa/seed/accounts.mjs', content: `import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
mkdirSync('data', { recursive: true });
if (process.argv[2] === 'seed') writeFileSync('data/accounts.json', JSON.stringify([{ persona: 'shopper' }, { persona: 'admin' }]));
else { const rows = JSON.parse(readFileSync('data/accounts.json')); const name = process.argv[2]; const row = rows.find(row => row.persona === name); row.email = process.env['QA_' + name.toUpperCase() + '_EMAIL']; row.password = process.env['QA_' + name.toUpperCase() + '_PASSWORD']; writeFileSync('data/accounts.json', JSON.stringify(rows)); }
` });
      }
      if (!existing.includes('.rio/qa/fixtures/fixtures.yaml')) {
        files.push({ path: '.rio/qa/fixtures/fixtures.yaml', content: JSON.stringify({ version: 1, services: [{ name: 'stripe', kind: 'http-mock', claims: ['api.stripe.com'], env: { STRIPE_API_BASE: '{{url}}' }, recordings: 'recordings/stripe', behaviors: ['approve'], default_behavior: 'approve' }] }) });
        files.push({ path: '.rio/qa/fixtures/recordings/stripe/approve.json', content: JSON.stringify({ behavior: 'approve', request: { method: 'POST', path: '/v1/charges' }, response: { status: 200, body: { id: 'ch_synthetic', object: 'charge', paid: true, status: 'succeeded' } } }) });
      }
    }
    await call('propose_setup', { files });
    process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
  } else {
  // Browser navigation returns human-readable accessibility text.
  const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: origins[0] + '/checkout' } });
  if (navigation.isError) throw new Error('Navigation failed: ' + JSON.stringify(navigation));
  const { guidance } = await call('read_owner_guidance');
  if (!guidance.some(row => row.path === 'src/checkout/REVIEW.md') || guidance.some(row => row.path.includes('admin'))) throw new Error('Wrong guidance scope');
  await call('step_done', { step: 1, outcome: 'passed' });
  const selected = input.context.journeys.length ? input.context.journeys : [{ journey: {
    version: 1, name: 'checkout', title: 'Checkout', persona: 'shopper', tags: ['smoke'],
    covers: { paths: ['src/checkout/**'], routes: ['/checkout'] }, preconditions: [],
    steps: [{ do: 'Open checkout', expect: 'Checkout is visible' }], success: ['Complete checkout'],
  } }];
  for (const { journey } of selected) {
    const candidate = { ...journey, title: 'Owner-guided ' + journey.title,
      goal: 'Complete checkout without losing entered data',
      guidance_refs: guidance.map(row => ({ path: row.path, hash: row.content_hash, start_line: 1, end_line: 1 })),
      ux_criteria: ['ux/error-recovery'],
      steps: [{ do: 'Retry after a declined payment', expect: 'The entered address remains available' }] };
    await call('write_journey', { journey: candidate, changes_data: true });
  }
  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
  }
} finally { await client.close(); }
