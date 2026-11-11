import { EvidenceCollector } from './evidence.mjs';
import { JourneySession } from './session.mjs';
import { HarnessCrash } from './execution.mjs';
import { probeCandidates, observationCandidates } from './findings.mjs';

/** Why an aborted journey stopped: its budget, the user's cancel, or an interruption. */
const abortReason = signal => ['budget', 'user'].includes(signal.reason) ? signal.reason : 'interrupted';

/** Owns one chain's browser context. The pod backend restores seed/app state
 * before construction; this class never resets between dependent journeys. */
export class CellController {
  constructor({ browser, writer, cell, criteria, guidance = {}, harness, handlers = {}, capturedMessages, fixtures, allowedOrigins, cellWallMs, modelProxy, prompt = {} }) {
    Object.assign(this, { browser, writer, cell, criteria, guidance, harness, handlers, capturedMessages, fixtures, allowedOrigins, cellWallMs, modelProxy, prompt });
    this.collector = new EvidenceCollector(browser, writer); this.sessions = []; this.bridges = []; this.transcript = [];
    this.controls = browser.controls;
  }
  setReplayJourney(name) { this.browser.setReplayJourney(name); }
  setReplayStep(step) { this.browser.setReplayStep(step); }
  runJourney(options) {
    if (this.closed || this.running) throw new Error('Cell is not ready for a journey');
    this.running = true; this.activeAbort = new AbortController();
    const signal = AbortSignal.any([options.signal, this.activeAbort.signal, this.modelProxy?.budget?.signal].filter(Boolean));
    if (this.modelProxy) { this.harness.proxyUrl = this.modelProxy.url; this.harness.proxyToken = this.modelProxy.token; }
    this.activeRun = this.executeJourney({ ...options, signal }).finally(() => { this.running = false; });
    return this.activeRun;
  }
  async executeJourney({ journey, signal, onStep }) {
    const guidance = this.guidance[journey.name] || [];
    const sharedGuidance = Object.values(this.guidance).every(value => JSON.stringify(value) === JSON.stringify(guidance));
    const session = new JourneySession({ browser: this.browser, writer: this.writer, collector: this.collector, journey, cell: this.cell,
      criteria: this.criteria, guidance, capturedMessages: this.capturedMessages, fixtures: this.fixtures, prompt: this.prompt, sharedGuidance, onStep });
    this.sessions.push(session);
    const bridge = await session.bridge({ handlers: this.handlers, allowedOrigins: this.allowedOrigins }); this.bridges.push(bridge);
    let result;
    try {
      if (signal?.aborted) return await session.finish({ reason: abortReason(signal) });
      result = await this.harness.run({ prompt: session.prompt(this.allowedOrigins), bridge, signal, wallMs: this.cellWallMs,
        onEvent: event => { this.transcript.push(event); } });
    } catch (error) {
      await session.finish({ reason: signal?.aborted ? abortReason(signal) : 'harness_error' });
      throw error instanceof HarnessCrash ? error : new HarnessCrash('QA harness startup failed');
    }
    const outcome = await session.finish({ reason: result.status === 'cancelled' ? result.reason : undefined });
    // No context/bridge disposal here: Playwright MCP owns a reference to the
    // existing context, and its disposal could close a dependent's cart page.
    return outcome;
  }
  close(options = {}) {
    this.closing ||= this.finishCell(options);
    return this.closing;
  }
  async finishCell({ reason } = {}) {
    this.closed = true;
    if (this.running) this.activeAbort.abort(reason || 'interrupted');
    try {
      await this.activeRun?.catch(() => {});
      for (const session of this.sessions) if (!session.finished) await session.finish({ reason: reason || 'interrupted' });
      await this.collector.finish({ journeys: this.sessions.map(session => session.journey.name), cell: this.cell, transcript: this.transcript });
      const journeys = Object.fromEntries(this.sessions.map(session => [session.journey.name, session.journey]));
      this.results = this.sessions.map(session => {
        const result = session.result;
        const artifacts = this.writer.artifacts.filter(artifact => artifact.journey === session.journey.name && artifact.cell.viewport === this.cell.viewport && artifact.cell.color_scheme === this.cell.color_scheme && artifact.step === undefined);
        result.evidence = [...new Set([...result.evidence, ...artifacts.map(artifact => artifact.id)])];
        result.finding_candidates = this.writer.sanitizer.value([
          ...probeCandidates(result.qa_findings, journeys), ...observationCandidates(result.hypotheses, journeys, this.criteria),
        ]);
        return result;
      });
      return this.results;
    } finally {
      try { for (const bridge of this.bridges) await bridge.close(); }
      finally { try { await this.browser.close(); } finally { await this.browser.disposeVideo(); } }
    }
  }
}
