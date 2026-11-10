import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { QaBackend } from './controller.mjs';
import { EvidenceCollector } from './evidence.mjs';
import { restrictedMcp } from './mcp.mjs';
import { ReplayRecorder, executeReplay } from './replay.mjs';
import { builtinProbeRules } from './probes.mjs';
import { chainContexts } from './context.mjs';

const sameCell = (a, b) => a?.viewport === b?.viewport && a?.color_scheme === b?.color_scheme;

/** Replays only retained data through the same restricted browser/fixture
 * bridge. The caller owns the fresh pod and its independent seed restore.
 * Matching exact sanitized boundary artifacts is intentionally conservative:
 * a different screen is inconclusive, never a refutation of original evidence.
 * Voters still assess whether the matched behavior demonstrates the hypothesis. */
export class ReplayBackend {
  constructor({ request, journeys, plan, ...options }) {
    Object.assign(this, { request, journeys, plan, options });
    this.runtime = new QaBackend({ ...options, replay: true });
  }
  async start({ cell, events, signal }) {
    this.cell = cell; this.signal = signal;
    const candidates = this.plan.chains.filter(chain => chain.journeys.includes(this.request.until.journey));
    if (candidates.length !== 1 || !this.plan.cells.some(item => sameCell(item, cell))) throw new Error('Replay target is outside plan');
    const chain = candidates[0], target = chain.journeys.indexOf(this.request.until.journey), names = chain.journeys.slice(0, target + 1);
    const seen = [...new Set(events.map(event => event.journey))];
    if (JSON.stringify(seen) !== JSON.stringify(names)) throw new Error('Replay prerequisites are incomplete');
    let lastJourney = -1;
    const steps = new Map();
    for (const event of events) {
      const index = names.indexOf(event.journey), journey = this.journeys[event.journey];
      const annotation = ['observe', 'assess', 'recommend', 'report_expectation_conflict'].includes(event.action);
      if (index < lastJourney || !journey || (!annotation && event.step !== (steps.get(event.journey) || 0) + 1)
        || event.step > journey.steps.length || (journey.viewports && !journey.viewports.includes(cell.viewport))) throw new Error('Replay boundary is out of order');
      lastJourney = index;
      if (event.action === 'step_done') steps.set(event.journey, event.step);
    }
    for (const name of names.slice(0, -1)) if (steps.get(name) !== this.journeys[name].steps.length) throw new Error('Replay prerequisite is incomplete');
    const contexts = chainContexts(chain, this.journeys, this.options.fixtures?.defaults);
    await this.runtime.start(signal);
    await this.runtime.restoreSeed({ chain, cell, context: contexts[names[0]], signal });
    this.active = await this.runtime.openCell({ cell, context: contexts[names[0]], signal });
    this.collector = new EvidenceCollector(this.active.browser, this.options.writer);
    this.recorded = { journey: names[0], step: 1, cell };
    const recorder = new ReplayRecorder(this.active.browser, () => this.recorded);
    this.bridge = await restrictedMcp(this.active.browser, { allowedOrigins: this.active.allowedOrigins,
      handlers: this.active.tools.handlers, sanitize: value => this.options.writer.sanitizer.value(value),
      before: call => recorder.before(call), after: call => recorder.after(call) });
    const [client, server] = InMemoryTransport.createLinkedPair();
    this.client = new Client({ name: 'rio-deterministic-replay', version: '1' });
    await this.bridge.server.connect(server); await this.client.connect(client);
  }
  position(event) {
    this.recorded = { journey: event.journey, step: event.step, cell: this.cell };
    this.active.browser.setReplayJourney(event.journey); this.active.browser.setReplayStep(event.step);
  }
  context(context) { return this.active.browser.controls.context(context); }
  call(call) { return this.client.callTool(call); }
  async capture(event) {
    const messages = await this.active.tools.collect(this.active.browser);
    const captured = await this.collector.step({ ...this.recorded, messages });
    // Keep fresh boundary evidence, without copying the harness's verdict.
    return captured.evidence;
  }
  matches(event, captured) {
    // All three must match. This also detects changed disabled/checked/input
    // states, text, accessibility semantics, layout, and hidden DOM content.
    return ['dom', 'accessibility', 'screenshot'].every(kind => {
      const originals = this.request.artifacts.filter(row => row.kind === kind && row.sanitized === true && row.journey === event.journey
        && row.step === event.step && sameCell(row.cell, this.cell) && event.arguments.evidence.includes(row.id));
      const fresh = this.options.writer.artifacts.find(row => row.kind === kind && captured.includes(row.id));
      return originals.length === 1 && fresh && originals[0].content_hash === fresh.content_hash;
    });
  }
  prerequisite(event, captured) { return this.matches(event, captured); }
  recurrence(event, captured) { return this.matches(event, captured); }
  async close() {
    try {
      if (this.collector) await this.collector.finish({ journeys: [...new Set(this.options.writer.artifacts.map(row => row.journey))], cell: this.cell });
    } finally {
      try { await this.client?.close(); }
      finally { try { await this.bridge?.close(); } finally { await this.runtime.close(); } }
    }
  }
}

export async function runReplay({ request, signal = new AbortController().signal, ...options }) {
  if (!request || !Array.isArray(request.artifacts) || !Array.isArray(request.events)) throw new Error('Invalid replay request');
  const criteria = options.criteria || await builtinProbeRules();
  const backend = new ReplayBackend({ ...options, request, criteria });
  const started = Date.now();
  const replay = await executeReplay({ events: request.events, until: request.until, backend, wallMs: options.budget.wall_ms, signal });
  // close() has retained the trace; attach it to the hypothesis alongside the
  // target screenshots/DOM even when prerequisites or the time budget fail.
  const result = options.writer.sanitizer.value({ ...replay, evidence: options.writer.manifest,
    replay_evidence: [...new Set([...replay.evidence, ...options.writer.artifacts.filter(row => row.kind === 'trace').map(row => row.id)])],
    until: request.until, cell: request.events[0]?.cell, wall_time_ms: Date.now() - started, tokens: 0,
    comparison: 'exact_sanitized_boundary_artifacts', journey_outcomes: [] });
  await options.checkpoint?.(result); return result;
}
