import { blake3 } from '@noble/hashes/blake3.js';
import { setTimeout as delay } from 'node:timers/promises';
import { executePlan, EnvironmentFailure, CellBudgetExhausted } from './execution.mjs';
import { openBrowser } from './browser.mjs';
import { CellController } from './cell.mjs';
import { Harness } from './harness.mjs';
import { AppTools } from './app-tools.mjs';
import { ModelProxy } from './model-proxy.mjs';
import { ProbeRun, builtinProbeRules, matchesRule } from './probes.mjs';
import { probeCandidates } from './findings.mjs';
import { chainContexts } from './context.mjs';

// Keys match the Worker's canonical encoding; version separates baseline ledgers.
export const qaCellId = (chain, cell, version = 'head') => Buffer.from(blake3(Buffer.from(JSON.stringify({ chain: chain.journeys, color_scheme: cell.color_scheme, version, viewport: cell.viewport })))).toString('hex');
const key = row => JSON.stringify([row.journey, row.cell.viewport, row.cell.color_scheme]);

export function remainingExploration(journey, cell, completed, guidance) {
  const visited = new Set([...completed].filter(row => row.journey !== 'exploratory' &&
    row.cell.viewport === cell.viewport && row.cell.color_scheme === cell.color_scheme).flatMap(row => row.visited_routes || []));
  const next = structuredClone(journey);
  next.steps = next.steps.filter(step => !visited.has(step.at));
  next.covers.routes = next.steps.map(step => step.at);
  const documents = new Map();
  for (const route of next.covers.routes) for (const document of guidance[`exploratory@${route}`] ||
      (guidance.exploratory || []).filter(document => !document.scope_dir)) documents.set(document.path, document);
  return { journey: next, guidance: [...documents.values()].sort((a,b) => a.scope_dir.length - b.scope_dir.length || a.path.localeCompare(b.path)) };
}
const environmentReasons = new Set(['app_not_ready', 'dependencies_unavailable', 'datastore_not_ready', 'seed_failed', 'seed_corrupt', 'seed_too_large', 'missing_tool', 'service_not_ready']);

/** Trusted controller composition. Repository commands are handled solely by
 * app; this backend consumes its narrow lifecycle and named fixture APIs. */
export class QaBackend {
  constructor({ contract, fixtures = {}, viewports, criteria, guidance = {}, writer, appControl, browserEndpoint, browserFiles,
    budget, model, version = 'head', harness = 'codex', auth = 'gateway', authFile, forward, seedTransfer, signal, credentialEnv = {},
    checkpoint = async () => {}, fetchImpl = fetch, browserFactory = openBrowser, harnessFactory = options => new Harness(options), maxFileBytes, replay = false, prompt = {} }) {
    Object.assign(this, { contract, fixtures, viewports, criteria, guidance, writer, appControl, browserEndpoint, browserFiles, budget, model, version, harness,
      auth, authFile, forward, seedTransfer, signal, credentialEnv, checkpoint, fetchImpl, browserFactory, harnessFactory, maxFileBytes, replay, prompt });
    this.writer.sanitizer.add(Object.values(credentialEnv));
    this.probes = new ProbeRun({ rules: criteria, overrides: contract.rules || {} });
    this.spending = new Map(); this.usage = []; this.completed = new Map(); this.missingPersonas = []; this.cellMetrics = [];
  }
  async failure({ stage, chain, cell, error }) {
    await this.writer.note('cell_failure', this.writer.sanitizer.value({ stage, journeys: chain.journeys, cell, message: String(error?.message || error).slice(0, 2000) }));
  }
  async app(path, { body, signal = this.signal } = {}) {
    const response = await this.fetchImpl(new URL(path, this.appControl), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(Math.min(this.budget.wall_ms, 120000)), ...(signal ? [signal] : [])]),
      headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const chunks = []; let size = 0;
    for await (const chunk of response.body || []) { size += chunk.length; if (size > 1024 * 1024) throw new EnvironmentFailure('app_not_ready'); chunks.push(chunk); }
    let value; try { value = JSON.parse(Buffer.concat(chunks)); } catch { throw new EnvironmentFailure('app_not_ready'); }
    return { response, value };
  }
  async waitReady(signal) {
    const started = Date.now();
    while (Date.now() - started < Math.min(this.budget.wall_ms, 120000)) {
      signal?.throwIfAborted();
      if (this.seedTransfer?.failure) throw new EnvironmentFailure(this.seedTransfer.failure.reason || 'seed_failed');
      try {
        const { response, value } = await this.app('/status', { signal });
        if (response.ok && value.ready === true) { this.missingPersonas = value.missing_personas || []; this.seed ||= value.seed; return; }
        if (value.failure?.outcome === 'failed') {
          const reason = environmentReasons.has(value.failure.reason) ? value.failure.reason : 'app_not_ready';
          await this.writer.note('startup_failure', { reason_code: reason, stage: this.writer.sanitizer.text(String(value.failure.stage || 'startup').slice(0, 256)) });
          throw new EnvironmentFailure(reason);
        }
      } catch (error) { if (signal?.aborted || error instanceof EnvironmentFailure) throw error; }
      await delay(100, undefined, { signal });
    }
    throw new EnvironmentFailure('app_not_ready');
  }
  async start(signal) {
    if (this.seedTransfer) await this.seedTransfer.start({ signal });
    await this.waitReady(signal);
  }
  async restoreSeed({ chain, cell, context, signal }) {
    this.current = { chain, cell, id: qaCellId(chain, cell, this.version) };
    for (const journey of chain.journeys) this.completed.delete(key({ journey, cell }));
    await this.waitReady(signal);
    const { response, value } = await this.app('/reset', { body: { context }, signal });
    if (!response.ok || !value.ready) throw new EnvironmentFailure(environmentReasons.has(value.reason) ? value.reason : 'seed_failed');
    this.missingPersonas = value.missing_personas || [];
  }
  // /reset is one ordered app-side transaction: restore, credential apply,
  // service reset, app startup and readiness. Never repeat these between dependents.
  async applyCredentials() {}
  async resetServiceBehaviors() {}
  openCell(options) { this.opening = this.buildCell(options); return this.opening; }
  async buildCell({ cell, context, signal }) {
    const active = this.active = { id: this.current.id };
    const appOrigin = new URL(this.contract.app.url).origin;
    const allowedOrigins = new Set([appOrigin]);
    const { response, value } = await this.app('/fixtures/status', { signal });
    if (!response.ok || !Array.isArray(value.services)) throw new EnvironmentFailure('service_not_ready');
    for (const service of value.services) {
      const declaration = this.fixtures.services?.find(item => item.name === service.name);
      if (!declaration || typeof service.url !== 'string') continue;
      const url = new URL(service.url), claims = (declaration.claims || []).map(claim => claim.replace(/:(80|443)$/, '').toLowerCase());
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && (['app', 'app.test'].includes(url.hostname) || claims.includes(url.hostname))) allowedOrigins.add(url.origin);
    }
    const viewport = this.viewports[cell.viewport]; if (!viewport) throw new Error('Undeclared viewport');
    active.browser = await this.browserFactory({ endpoint: this.browserEndpoint, signal, connectTimeoutMs: Math.min(this.budget.cell_wall_ms, 30000), viewport, viewports: this.viewports, colorScheme: cell.color_scheme, context,
      video: this.contract.evidence?.video === true, allowedOrigins: [...allowedOrigins], probeRun: this.probes, journey: this.current.chain.journeys[0] });
    signal.throwIfAborted();
    active.tools = new AppTools({ endpoint: this.appControl, browser: active.browser, browserFiles: this.browserFiles, maxFileBytes: this.maxFileBytes,
      sanitizer: this.writer.sanitizer, appOrigins: [appOrigin], allowedOrigins: [...allowedOrigins], personas: this.contract.personas,
      fixtures: this.fixtures, credentialEnv: this.credentialEnv, fetchImpl: this.fetchImpl, signal });
    active.allowedOrigins = [...allowedOrigins];
    if (this.replay) return active;
    if (this.auth !== 'subscription') {
      const remaining = this.budget.tokens - (this.spending.get(active.id) || 0);
      if (remaining <= 0) throw new CellBudgetExhausted('Cell token allowance exhausted');
      active.proxy = new ModelProxy({ forward: this.forward, model: this.model, record: async usage => { this.usage.push(usage); } });
      active.proxy.startCell({ id: active.id, ...cell }, remaining); await active.proxy.listen();
    }
    active.controller = new CellController({ browser: active.browser, writer: this.writer, cell, criteria: this.criteria, guidance: this.guidance,
      harness: this.harnessFactory({ kind: this.harness, auth: this.auth, authFile: this.authFile, model: this.model, sanitizer: this.writer.sanitizer }),
      fixtures: active.tools, allowedOrigins: [...allowedOrigins], cellWallMs: this.budget.cell_wall_ms, modelProxy: active.proxy, prompt: this.prompt });
    signal.throwIfAborted();
    return active.controller;
  }
  async runJourney({ journey, cell, environment, signal, onStep }) {
    if (this.explorationRoutes?.length && journey.name === 'exploratory') {
      const remaining = remainingExploration(journey, cell, this.completed.values(), this.guidance);
      journey = remaining.journey;
      this.guidance.exploratory = remaining.guidance;
      if (!journey.steps.length) {
        const result = { journey: journey.name, cell, outcome: 'passed', evidence: [], steps: [], visited_routes: [], ux_assessment: [] };
        this.completed.set(key(result), result); await this.checkpoint(this.snapshot()); return result;
      }
    }
    if (this.missingPersonas.includes(journey.persona)) return { journey: journey.name, cell, outcome: 'skipped', reason: 'missing_credentials', evidence: [] };
    const result = await environment.runJourney({ journey, signal, onStep });
    this.completed.set(key(result), result);
    await this.checkpoint(this.snapshot());
    return result;
  }
  async closeCell({ environment }) {
    await this.opening?.catch(() => {}); this.opening = undefined;
    const active = this.active; this.active = undefined;
    if (!active) return [];
    let results = [];
    try {
      const controller = environment || active.controller;
      if (controller) results = await controller.close();
      else await active.browser?.close();
    } finally {
      try { await active.proxy?.close(); }
      finally {
        if (active.proxy) this.spending.set(active.id, (this.spending.get(active.id) || 0) + active.proxy.spent);
        await active.tools?.close();
      }
    }
    for (const result of results) this.completed.set(key(result), result);
    await this.checkpoint(this.snapshot()); return results;
  }
  async recordCellMetric(metric) {
    const id = qaCellId({ journeys: metric.chain }, metric.cell, this.version);
    const usage = this.usage.filter(row => row.cell.id === id);
    this.cellMetrics.push({ ...metric, id, version: this.version, scope: 'browser_chain_cell',
      tokens: this.auth === 'subscription' ? null : usage.reduce((sum, row) => sum + row.charged_tokens, 0),
      usage_estimated: this.auth === 'subscription' || usage.some(row => row.estimated), usd: null });
    // Persist each measurement before the next cell starts. A later controller
    // failure must not erase completed-cell costs from the retained checkpoint.
    await this.checkpoint(this.snapshot());
  }
  snapshot() {
    const outcomes = [...this.completed.values()];
    // The host consumes these top-level collections even when a deadline or
    // cleanup error prevents runQa's final composition. Do not finalize
    // run-scoped minority rules against an unfinished population here.
    return this.writer.sanitizer.value({ outcome: 'partial', seed: this.seed || { status: 'not_run', duration_ms: 0 }, journey_outcomes: outcomes, evidence: this.writer.manifest,
      qa_findings: outcomes.flatMap(row => row.finding_candidates || []),
      hypotheses: outcomes.flatMap(row => row.hypotheses || []),
      qa_recommendations: outcomes.flatMap(row => row.qa_recommendations || []),
      ux_assessment: outcomes.flatMap(row => row.ux_assessment || []),
      probe_assessments: this.probes.assessments.filter(row => row.scope !== 'run'),
      cell_metrics: this.cellMetrics, usage: this.usage, tokens: this.auth === 'subscription' ? 'unmetered' : this.usage.reduce((sum, row) => sum + row.charged_tokens, 0) });
  }
  async close() {
    try { if (this.active || this.opening) await this.closeCell({}); }
    finally { await this.seedTransfer?.close(); }
  }
}

export async function runQa({ plan, journeys, signal = new AbortController().signal, ...options }) {
  for (const chain of plan.chains) chainContexts(chain, journeys, options.fixtures?.defaults || {});
  const criteria = [...(options.criteria || await builtinProbeRules()), ...(options.contract.rules?.add || []).map(rule => ({ ...rule, kind: 'judged' }))]
    .filter(rule => rule.kind === 'probe' || !matchesRule(options.contract.rules?.disable || [], rule.id));
  const backend = new QaBackend({ ...options, criteria, signal });
  backend.explorationRoutes = plan.exploration_routes || [];
  const started = Date.now(), startup = AbortSignal.any([signal, AbortSignal.timeout(options.budget.wall_ms)]);
  let result;
  try {
    try { await backend.start(startup); }
    catch (error) {
      const reason = signal.aborted ? 'interrupted' : Date.now() - started >= options.budget.wall_ms ? 'budget' : error.reason || 'app_not_ready';
      result = { outcome: 'partial', journey_outcomes: plan.chains.flatMap(chain => plan.cells.flatMap(cell => chain.journeys.filter(name => !journeys[name].viewports || journeys[name].viewports.includes(cell.viewport)).map(journey => ({ journey, cell, outcome: ['interrupted', 'budget'].includes(reason) ? 'cancelled' : 'not_run', reason, evidence: [] })))) };
    }
    result ||= await executePlan({ plan, journeys, backend, defaults: options.fixtures?.defaults, runWallMs: Math.max(1, options.budget.wall_ms - (Date.now() - started)), cellWallMs: options.budget.cell_wall_ms, signal, control: options.control, progress: options.progress });
    const probes = backend.probes.finalize();
    result = options.writer.sanitizer.value({ ...backend.snapshot(), ...result, wall_time_ms: Date.now() - started,
      cell_metrics: backend.cellMetrics,
      qa_findings: [...result.journey_outcomes.flatMap(row => row.finding_candidates || []), ...probeCandidates(probes.findings, journeys)],
      hypotheses: result.journey_outcomes.flatMap(row => row.hypotheses || []),
      qa_recommendations: result.journey_outcomes.flatMap(row => row.qa_recommendations || []),
      ux_assessment: result.journey_outcomes.flatMap(row => row.ux_assessment || criteria.filter(rule => rule.kind === 'judged' && (rule.id.startsWith('ux/') || journeys[row.journey].ux_criteria?.includes(rule.id))).map(rule => ({
        rule_id: rule.id, journey: row.journey, cell: row.cell, status: 'not_assessed', reason: row.reason || 'not_assessed_by_harness', evidence: [],
      }))), probe_summaries: probes.summaries, probe_gaps: probes.gaps,
      probe_assessments: backend.probes.assessments.filter(row => row.scope !== 'run' || result.outcome === 'complete') });
    // Lifecycle diagnostics are evidence too, including on interrupted runs.
    // Use a fresh, tightly bounded signal after the run's signal has expired.
    try {
      const { response, value } = await backend.app('/fixtures/events', { signal: AbortSignal.timeout(2000) });
      if (response.ok && Array.isArray(value.events)) result.network_events = options.writer.sanitizer.value(value.events);
    } catch { result.network_events_unavailable = true; }
    await backend.checkpoint(result); return result;
  } finally { await backend.close(); }
}
