import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv/dist/2020.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recommendationInput, assessmentInput, expectationConflictInput } from './contracts.mjs';
import { presentToolResult } from './fixture-client.mjs';

// Never forward newly introduced upstream tools implicitly. In particular,
// evaluate/run_code, arbitrary uploads, downloads, installation and filesystem
// tools are excluded even if Playwright MCP advertises them.
export const PLAYWRIGHT_TOOLS = new Set([
  'browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_click',
  'browser_type', 'browser_select_option', 'browser_press_key', 'browser_wait_for',
  'browser_hover',
]);
const string = { type: 'string', minLength: 1 };
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const RIO_TOOLS = [
  ['login', 'Log in as a declared persona. Credentials are resolved outside the prompt.', schema({ persona: string })],
  ['set_viewport', 'Select a declared viewport or its orientation preset.', schema({ viewport: string })],
  ['set_color_scheme', 'Set light or dark mode.', schema({ color_scheme: { enum: ['light', 'dark'] } })],
  ['upload_fixture', 'Upload a declared fixture by name; host paths are forbidden.', schema({ name: string })],
  ['read_mail', 'Read sanitized captured mail and extracted links for a persona.', schema({ persona: string })],
  ['read_sms', 'Read sanitized captured SMS for a persona.', schema({ persona: string })],
  ['read_webhooks', 'Read sanitized captured webhooks for a declared service.', schema({ service: string })],
  ['set_service_behavior', 'Select a declared behavior of a service double.', schema({ service: string, behavior: string })],
  ['set_network', 'Select a reproducible network condition.', schema({ network: { enum: ['online', 'slow-3g', 'offline'] } })],
  ['set_geolocation', 'Set the browser location.', schema({ latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 } })],
  ['read_dependencies', 'Read recorded unavailable external hosts. A failure is a prerequisite only if the current journey needs that host.', schema({})],
  ['step_done', 'Mark a step boundary for independent evidence capture and probing. For an unavailable prerequisite use skipped, explain the dependency in reason, and cite its recorded host in blocked_dependency.', schema({ step: { type: 'integer', minimum: 1 }, outcome: { enum: ['passed', 'failed', 'skipped'] }, reason: { type: 'string' }, blocked_dependency: string }, ['step', 'outcome'])],
  ['observe', 'Record an artifact-backed observation for verification. kind must equal the category of the cited rule in the supplied criteria (a rule with category ux takes kind ux). element_paths is optional; each entry is a CSS selector run with document.querySelector on the page that is open when you call observe, so it must match an element present there now. Build selectors only from tag names and attributes you know exist (for example input[name=email]); snapshot refs such as e12, routes or URLs, accessible names, visible text and descriptive phrases are not selectors, and an accessible name is usually not an aria-label attribute. If the element is not on the current page or you are unsure of a selector, omit element_paths. A reply with dropped means nothing was recorded: correct the field it names and resubmit the same finding under the same rule_id.', schema({ rule_id: string, kind: { enum: ['functional', 'ux', 'style', 'accessibility'] }, expected: { type: 'object' }, observed: { type: 'object' }, evidence: { type: 'array', items: string, minItems: 1 }, suggested_fix: string, element_paths: { type: 'array', items: string } }, ['rule_id', 'kind', 'expected', 'observed', 'evidence', 'suggested_fix'])],
  ['assess', 'Record UX criterion coverage, including passed journeys. Batch coverage in assessments to avoid repeated model turns. Assessed means checked with nothing left to file: record each friction you noticed with observe or recommend first and cite it in the reason. Assessed criteria require retained artifact IDs; other statuses require a reason.',
    { type: 'object', oneOf: [assessmentInput, schema({ assessments: { type: 'array', minItems: 1, maxItems: 64, items: assessmentInput } })] }],
  ['recommend', 'Propose an evidence-backed UX improvement for friction observed during the journey, including in steps that passed. Cite applicable owner guidance or the supplied versioned heuristic. basis.heuristic is checked verbatim against the cited rule\'s source: source is source.title, version is source.version and reference is source.url (the URL, not a principle name or rule id); name the specific principle in observed_friction instead. Every listed step needs at least one evidence ID captured at that step. A reply with dropped means nothing was recorded: correct the field it names and resubmit. Benefits remain expected; this cannot fail a journey.', recommendationInput],
  ['report_expectation_conflict', 'Record conflicting owner requirements or a committed expectation that needs reconciliation. Cite immutable guidance and observed step evidence. This is neither a defect nor permission to rewrite expectations.', expectationConflictInput],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));
const failure = message => ({ isError: true, content: [{ type: 'text', text: message }] });

export async function restrictedMcp(browser, { handlers = {}, record = async () => {}, before = async () => {}, after = async () => {}, sanitize = value => value, allowedOrigins = [], authorTools = [] } = {}) {
  if (authorTools.some(tool => !['write_journey', 'read_owner_guidance'].includes(tool.name)) || new Set(authorTools.map(tool => tool.name)).size !== authorTools.length) throw new Error('Invalid authoring tool capability');
  // MCP writes automatic snapshots even when session recording is disabled.
  // Keep those private and ephemeral; only Rio's sanitized evidence is retained.
  const outputDir = await mkdtemp(join(tmpdir(), 'rio-qa-mcp-'));
  let upstream, client, server;
  const close = async () => {
    try { await server?.close(); }
    finally {
      try { await client?.close(); }
      finally {
        try { await upstream?.close(); }
        finally { await rm(outputDir, { recursive: true, force: true }); }
      }
    }
  };
  try {
    upstream = await createConnection({ capabilities: ['core'], saveSession: false, webmcp: false, outputDir,
      snapshot: { mode: 'none' }, codegen: 'none' }, async () => browser.context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await upstream.connect(serverTransport);
    client = new Client({ name: 'rio-browser-bridge', version: '0.1.0' });
    await client.connect(clientTransport);
    const available = (await client.listTools()).tools.filter(tool => PLAYWRIGHT_TOOLS.has(tool.name)).map(tool => {
      const inputSchema = structuredClone(tool.inputSchema);
      // Snapshot inspection must never become an arbitrary file-write tool.
      delete inputSchema.properties?.filename;
      inputSchema.additionalProperties = false;
      return { ...tool, inputSchema };
    });
    const tools = [...available, ...RIO_TOOLS, ...authorTools];
    const validators = new Map(tools.map(tool => [tool.name, new Ajv({ strict: false }).compile(tool.inputSchema)]));
    server = new Server({ name: 'rio-qa', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    const dispatch = async ({ params }) => {
      const { name, arguments: args = {} } = params;
      const validate = validators.get(name);
      if (!validate || !validate(args)) {
        await record({ tool: name, rejected: true });
        return failure('Tool or arguments are not permitted by the QA contract.');
      }
      if (name === 'browser_navigate') {
        let url;
        try { url = new URL(args.url); } catch { return failure('Invalid navigation URL.'); }
        if (!['http:', 'https:'].includes(url.protocol) || (allowedOrigins.length && !allowedOrigins.includes(url.origin))) {
          await record({ tool: name, rejected: true });
          return failure('Navigation is outside the QA application origins.');
        }
      }
      // Record persona/fixture names only. Backend credentials never enter args.
      await record(sanitize({ tool: name, arguments: args }));
      try {
        const state = await before({ tool: name, arguments: args });
        let result;
        if (PLAYWRIGHT_TOOLS.has(name)) {
          result = await client.callTool({ name, arguments: args });
          // Automatic Playwright snapshots are file links in the pinned MCP
          // release. The harness has no filesystem tools: request an explicit
          // inline snapshot after actions instead, then sanitize it as usual.
          if (name !== 'browser_snapshot' && !result.isError) {
            const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });
            result = { ...result, content: [...(result.content || []), ...(snapshot.content || [])] };
          }
        }
        else {
          const handler = handlers[name] || browser.handlers?.[name];
          result = handler ? await handler(args) : failure(`QA backend for ${name} is not configured.`);
          // Login changes the page, and evidence/probes at a step boundary can
          // refresh Playwright's accessibility references. Return the current
          // snapshot so subsequent actions never use pre-capture references.
          if (['login', 'step_done'].includes(name) && !result.isError) {
            const snapshot = await client.callTool({ name: 'browser_snapshot', arguments: {} });
            result = { ...result, content: [...(result.content || []), ...(snapshot.content || [])] };
          }
        }
        await after({ tool: name, arguments: args, result, state });
        // Step screenshots are masked by the page style before capture; text
        // sanitization cannot apply to pixels and must not rewrite image data.
        const images = (result.content || []).filter(part => part.type === 'image');
        if (!images.length) return presentToolResult(result, sanitize);
        const presented = presentToolResult({ ...result, content: result.content.filter(part => part.type !== 'image') }, sanitize);
        return { ...presented, content: [...(presented.content || []), ...images] };
      } catch {
        // Backend errors may contain credential values; do not echo them.
        return failure('QA tool failed; inspect the sanitized run evidence.');
      }
    };
    // A step marker cannot overtake a pending navigation or another capture,
    // even when a harness issues parallel MCP requests.
    let pending = Promise.resolve();
    server.setRequestHandler(CallToolRequestSchema, request => {
      const operation = pending.then(() => dispatch(request));
      pending = operation.catch(() => {});
      return operation;
    });
    return { server, tools, close };
  } catch (error) {
    await close();
    throw error;
  }
}
