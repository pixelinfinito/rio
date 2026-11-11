import { chainContexts } from './context.mjs';

/** The backend owns datastore restore, credentials, doubles and harness processes.
 * A cell is the isolation boundary; reset never occurs between dependent journeys.
 */
export class HarnessCrash extends Error {}
export class CellBudgetExhausted extends Error {}
export class EnvironmentFailure extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
const cancelled = (journey, cell, reason) => ({ journey, cell, outcome: 'cancelled', reason, evidence: [] });
const reasonForAbort = signal => ['interrupted', 'user'].includes(signal.reason) ? signal.reason : 'budget';
const sleep = (ms, signal) => new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});
/** How often the host's pause and cancel requests are read. */
export const CONTROL_POLL_MS = 500;

async function bounded(operation, signal) {
  signal.throwIfAborted();
  let abort;
  const aborted = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(operation), aborted]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** `control` is the host's live requests: `paused()` holds the queue before the
 * next cell and `cancelled(journey, cell)` cancels a cell (`reason: 'user'`).
 * `progress` receives `{ journey, cell, step, outcome }` as cells start and end.
 */
export async function executePlan({ plan, journeys, backend, defaults = {}, runWallMs, cellWallMs, signal = new AbortController().signal, control = {}, progress = () => {} }) {
  // Validate the whole plan before any reset or application process can start.
  const resolved = new Map(plan.chains.map(chain => [chain, chainContexts(chain, journeys, defaults)]));
  const run = new AbortController();
  const stop = () => run.abort(signal.reason === 'budget' ? 'budget' : 'interrupted');
  if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => run.abort('budget'), runWallMs);
  const outcomes = [], cellMetrics = [];
  let partial = false;
  try {
    for (const chain of plan.chains) {
      for (const cell of plan.cells) {
        const names = chain.journeys.filter(name => !journeys[name].viewports || journeys[name].viewports.includes(cell.viewport));
        if (!names.length) continue;
        const report = (name, step, outcome) => { try { progress({ journey: name, cell, step, outcome }); } catch { /* Progress is advisory. */ } };
        const userCancelled = () => names.some(name => control.cancelled?.(name, cell));
        // A paused queue finishes the running cell and waits before the next one.
        while (control.paused?.() && !run.signal.aborted && !userCancelled()) await sleep(CONTROL_POLL_MS, run.signal);
        if (run.signal.aborted || userCancelled()) {
          const reason = run.signal.aborted ? reasonForAbort(run.signal) : 'user';
          for (const name of names) { outcomes.push(cancelled(name, cell, reason)); report(name, 0, 'cancelled'); }
          partial = true; continue;
        }
        for (const name of names) report(name, 0, 'running');
        const cellStarted = performance.now();
        const cellAbort = new AbortController();
        const abort = () => cellAbort.abort(run.signal.reason);
        run.signal.addEventListener('abort', abort, { once: true });
        const cellTimer = setTimeout(() => cellAbort.abort('budget'), cellWallMs);
        const watch = setInterval(() => { if (userCancelled()) cellAbort.abort('user'); }, CONTROL_POLL_MS);
        let attemptOutcomes = [];
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            let environment, stage = 'seed_restore';
            attemptOutcomes = [];
            try {
              // Each retry restores again; neither successful checkout nor its
              // prerequisites share browser or database state with another cell.
              const contexts = resolved.get(chain), context = contexts[names[0]];
              await bounded(() => backend.restoreSeed({ chain, cell, context, signal: cellAbort.signal }), cellAbort.signal);
              await bounded(() => backend.applyCredentials({ signal: cellAbort.signal }), cellAbort.signal);
              await bounded(() => backend.resetServiceBehaviors({ signal: cellAbort.signal }), cellAbort.signal);
              stage = 'browser_start';
              environment = await bounded(() => backend.openCell({ cell, context, signal: cellAbort.signal }), cellAbort.signal);
              stage = 'journey_execution';
              for (const name of names) {
                const journey = journeys[name];
                if (journey.after?.some(predecessor => !attemptOutcomes.some(result => result.journey === predecessor && result.outcome === 'passed'))) {
                  attemptOutcomes.push({ journey: name, cell, outcome: 'skipped', reason: 'precondition_failed', evidence: [] });
                  continue;
                }
                environment?.setReplayJourney?.(name);
                environment?.setReplayStep?.(1);
                if (environment?.controls?.context) await bounded(() => environment.controls.context(contexts[name]), cellAbort.signal);
                const result = await bounded(() => backend.runJourney({ journey, cell, context: contexts[name], environment, signal: cellAbort.signal, onStep: step => report(name, step, 'running') }), cellAbort.signal);
                attemptOutcomes.push({ ...result, journey: name, cell });
                if (result.outcome === 'cancelled' && result.reason === 'budget') { cellAbort.abort('budget'); cellAbort.signal.throwIfAborted(); }
              }
              break;
            } catch (error) {
              try { await backend.failure?.({ stage, chain, cell, error }); } catch { /* Preserve the original failure even when its diagnostic sink fails. */ }
              if (!cellAbort.signal.aborted && error instanceof HarnessCrash && attempt === 0) continue;
              const completed = new Set(attemptOutcomes.map(result => result.journey));
              const reason = cellAbort.signal.aborted ? reasonForAbort(cellAbort.signal) : error instanceof CellBudgetExhausted ? 'budget' : error instanceof EnvironmentFailure ? error.reason : 'harness_error';
              for (const name of names.filter(name => !completed.has(name))) {
                attemptOutcomes.push(error instanceof EnvironmentFailure ? { journey: name, cell, outcome: 'not_run', reason, evidence: [] } : cancelled(name, cell, reason));
              }
              partial = true;
              break;
            } finally {
              // closeCell must terminate the harness too, including a startup
              // that was interrupted before it returned its context.
              const finalized = await backend.closeCell({ environment, cell });
              if (Array.isArray(finalized)) for (const result of finalized) {
                const index = attemptOutcomes.findIndex(outcome => outcome.journey === result.journey);
                if (index >= 0) attemptOutcomes[index] = { ...result, ...attemptOutcomes[index], evidence: result.evidence };
              }
            }
          }
        } finally {
          clearTimeout(cellTimer); clearInterval(watch); run.signal.removeEventListener('abort', abort);
          // One measurement includes reset, retries, all dependent journeys and
          // cleanup. Never divide shared-chain work into invented journey costs.
          const metric = { chain: [...chain.journeys], journeys: names, cell: { ...cell }, wall_time_ms: Math.ceil(performance.now() - cellStarted) };
          cellMetrics.push(metric);
          await backend.recordCellMetric?.(metric);
        }
        outcomes.push(...attemptOutcomes);
        for (const row of attemptOutcomes) report(row.journey, stepReached(row), row.outcome);
      }
    }
  } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
  return { outcome: partial ? 'partial' : 'complete', journey_outcomes: outcomes, cell_metrics: cellMetrics };
}

/** The last step a journey reached, from its step rows or failed step. */
function stepReached(row) {
  const steps = Array.isArray(row.steps) ? row.steps.map(step => step.step).filter(Number.isSafeInteger) : [];
  return Math.max(0, row.failed_step ?? 0, ...steps);
}

export function aggregateJourney(outcomes) {
  if (!outcomes.length) return 'not_run';
  for (const state of ['failed', 'cancelled', 'not_run', 'skipped']) if (outcomes.some(outcome => outcome.outcome === state)) return state;
  return 'passed';
}
