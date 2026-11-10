import { contract, validateContract } from './contracts.mjs';
import { presentToolResult } from './fixture-client.mjs';

const validEvent = validateContract(contract('qa-replay-v1'));
const contextActions = new Set(['set_network', 'set_geolocation', 'set_viewport', 'set_color_scheme']);
const payload = result => {
  try { return JSON.parse(result.content.find(item => item.type === 'text').text); } catch { return {}; }
};

/** Capture targets before actions detach or navigate away from their elements.
 * normalize() is Playwright's pinned public ref-to-locator API; _selector is
 * the pinned transport selector, never evaluated as JavaScript. Other target
 * strings are parsed by Playwright MCP's own locator parser during replay. */
export class ReplayRecorder {
  constructor(browser, metadata) { this.browser = browser; this.metadata = metadata; this.links = browser.replayLinks ||= new Map(); }
  async before({ tool, arguments: args }) {
    const state = { ...this.metadata(), args: structuredClone(args) };
    if (args.target && /^(f\d+)?e\d+$/.test(args.target)) {
      const locator = await this.browser.page.getByRef(args.target).normalize();
      state.selector = locator._selector;
      if (!state.selector || /aria-ref=/.test(state.selector)) throw new Error('Replay target cannot be normalized');
    } else state.selector = args.target;
    return state;
  }
  async after({ tool, arguments: args, result, state }) {
    if (tool === 'assess' && Array.isArray(args.assessments)) {
      for (const assessment of args.assessments) await this.after({ tool, arguments: assessment, result, state });
      return;
    }
    if (tool === 'read_dependencies') return; // Read-only diagnostics are retained in the transcript/network evidence.
    if (contextActions.has(tool) && !result.isError) return; // Browser controls recorded the committed change.
    let action, parameters;
    switch (tool) {
      case 'browser_navigate': action = 'navigate'; parameters = this.links.has(args.url)
        ? { url: '[captured-link]', capture: this.links.get(args.url) } : { url: args.url }; break;
      case 'browser_navigate_back': action = 'navigate_back'; parameters = {}; break;
      case 'browser_click': action = 'click'; parameters = { selector: state.selector, ...pick(args, ['doubleClick', 'button', 'modifiers']) }; break;
      case 'browser_hover': action = 'hover'; parameters = { selector: state.selector }; break;
      case 'browser_type': action = 'type'; parameters = { selector: state.selector, value: args.text, ...pick(args, ['submit', 'slowly']) }; break;
      case 'browser_select_option': action = 'select'; parameters = { selector: state.selector, values: args.values }; break;
      case 'browser_press_key': action = 'press_key'; parameters = { key: args.key }; break;
      case 'browser_wait_for': action = 'wait'; parameters = { ...pick(args, ['text', 'textGone']), ...(args.time === undefined ? {} : { milliseconds: Math.round(Math.min(args.time, 30) * 1000) }) }; break;
      case 'browser_snapshot': action = 'inspect'; parameters = { ...args, ...(state.selector ? { target: state.selector } : {}) }; break;
      case 'step_done': action = tool; parameters = { outcome: args.outcome, evidence: payload(result).evidence || [], ...pick(args, ['reason', 'blocked_dependency']) }; break;
      case 'observe': action = tool; parameters = { observation_id: payload(result).observation_id || 'dropped' }; break;
      case 'recommend': action = tool; parameters = { recommendation_id: payload(result).recommendation_id || 'dropped' }; break;
      case 'assess': action = tool; parameters = { rule_id: args.rule_id }; break;
      case 'report_expectation_conflict': action = tool; parameters = { conflict_id: payload(result).conflict_id || 'dropped' }; break;
      case 'set_geolocation': action = tool; parameters = { geolocation: args }; break;
      case 'set_viewport': action = tool; parameters = { name: args.viewport }; break;
      default: action = tool; parameters = args;
    }
    const event = { version: 1, sequence: this.browser.replayEvents.length, journey: state.journey, step: state.step, cell: state.cell,
      action, arguments: parameters, result: result.isError ? 'failed' : 'completed' };
    if (!validEvent(event)) throw new Error('Tool produced an invalid replay event');
    this.browser.replayEvents.push(event);
    if (['read_mail', 'read_sms'].includes(tool) && !result.isError) {
      const messages = payload(presentToolResult(result, value => value)).messages || [];
      for (const [message, row] of messages.entries()) for (const [link, url] of (row.links || []).entries()) {
        this.links.set(url, { sequence: event.sequence, message, link });
      }
    }
  }
}
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));

/** Translate data-only events back to the restricted MCP tool vocabulary. No
 * shell, evaluation, host path or dynamic code execution exists in this path. */
export function replayCall(event) {
  const a = event.arguments;
  switch (event.action) {
    case 'navigate': return { name: 'browser_navigate', arguments: { url: a.url } };
    case 'navigate_back': return { name: 'browser_navigate_back', arguments: {} };
    case 'click': return { name: 'browser_click', arguments: { target: a.selector, ...pick(a, ['doubleClick', 'button', 'modifiers']) } };
    case 'hover': return { name: 'browser_hover', arguments: { target: a.selector } };
    case 'type': return { name: 'browser_type', arguments: { target: a.selector, text: a.value, ...pick(a, ['submit', 'slowly']) } };
    case 'select': return { name: 'browser_select_option', arguments: { target: a.selector, values: a.values } };
    case 'press_key': return { name: 'browser_press_key', arguments: a };
    case 'wait': return { name: 'browser_wait_for', arguments: { ...pick(a, ['text', 'textGone']), ...(a.milliseconds === undefined ? {} : { time: a.milliseconds / 1000 }) } };
    case 'inspect': return { name: 'browser_snapshot', arguments: a };
    case 'set_viewport': return { name: 'set_viewport', arguments: { viewport: a.name } };
    case 'set_geolocation': return { name: 'set_geolocation', arguments: a.geolocation };
    case 'login': case 'upload_fixture': case 'read_mail': case 'read_sms': case 'read_webhooks': case 'set_service_behavior': case 'set_network': case 'set_color_scheme':
      return { name: event.action, arguments: a };
    case 'set_context': case 'step_done': case 'observe': case 'assess': case 'recommend': case 'report_expectation_conflict': return null;
    default: throw new Error('Unknown replay action');
  }
}

/** The backend starts a fresh seed-restored pod and evaluates artifact-backed
 * expectations, not the original harness's prose or recorded pass/fail claim. */
export async function executeReplay({ events, until, backend, wallMs, signal = new AbortController().signal }) {
  if (!Number.isFinite(wallMs) || wallMs <= 0) throw new Error('Invalid replay budget');
  if (!until?.journey || !Number.isSafeInteger(until.step) || until.step < 1) throw new Error('Invalid replay target');
  let cell;
  for (const [index, event] of events.entries()) {
    if (!validEvent(event) || event.sequence !== index) throw new Error('Invalid replay event sequence');
    cell ||= event.cell;
    if (event.cell.viewport !== cell.viewport || event.cell.color_scheme !== cell.color_scheme) throw new Error('Replay mixes cells');
  }
  const last = events.findIndex(event => event.journey === until.journey && event.step === until.step && event.action === 'step_done');
  if (last < 0) return { outcome: 'prerequisites_failed', reason: 'target_not_recorded', evidence: [] };
  const abort = new AbortController(), stop = () => abort.abort(signal.reason || 'interrupted');
  if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => abort.abort('budget'), wallMs);
  let listener;
  const interrupted = new Promise((_, reject) => { listener = () => reject(new Error('Replay interrupted')); abort.signal.addEventListener('abort', listener, { once: true }); });
  // Every operation receives the same cancellation signal; close must also
  // terminate a partially started pod after timeout.
  const bounded = work => { abort.signal.throwIfAborted(); return Promise.race([Promise.resolve().then(work), interrupted]); };
  const evidence = [], captures = new Map(); let position;
  try {
    await bounded(() => backend.start({ cell, events: events.slice(0, last + 1), signal: abort.signal }));
    for (const recorded of events.slice(0, last + 1)) {
      const event = structuredClone(recorded);
      position = { journey: event.journey, step: event.step, sequence: event.sequence };
      if (event.action === 'navigate' && event.arguments.capture) {
        const ref = event.arguments.capture, url = captures.get(ref.sequence)?.[ref.message]?.links?.[ref.link];
        if (ref.sequence >= event.sequence || typeof url !== 'string' || url.includes('[redacted]')) return { outcome: 'prerequisites_failed', reason: 'capture_binding_unavailable', at: position, evidence };
        event.arguments.url = url;
        delete event.arguments.capture;
      }
      if (!['step_done', 'observe', 'assess', 'recommend', 'report_expectation_conflict'].includes(event.action) && JSON.stringify(event.arguments).includes('[redacted]')) return { outcome: 'prerequisites_failed', reason: 'redacted_input', at: position, evidence };
      await bounded(() => backend.position?.(event, abort.signal));
      if (event.action === 'step_done') {
        const captured = await bounded(() => backend.capture(event, abort.signal)); evidence.push(...captured);
        if (event.journey === until.journey && event.step === until.step) {
          const recurred = await bounded(() => backend.recurrence(event, captured, abort.signal));
          return { outcome: recurred === true ? 'recurred' : 'not_recurred', evidence };
        }
        if (event.arguments.outcome !== 'passed' || !await bounded(() => backend.prerequisite(event, captured, abort.signal))) return { outcome: 'prerequisites_failed', reason: 'expectation_not_met', at: position, evidence };
      } else if (event.action === 'set_context') await bounded(() => backend.context(event.arguments.context, abort.signal));
      else {
        const call = replayCall(event);
        if (call) {
          const result = await bounded(() => backend.call(call, abort.signal));
          if (result?.isError && event.result !== 'failed') return { outcome: 'prerequisites_failed', reason: 'action_failed', at: position, evidence };
          if (['read_mail', 'read_sms'].includes(event.action) && !result?.isError) captures.set(event.sequence, payload(result).messages || []);
        }
      }
    }
  } catch {
    return { outcome: 'prerequisites_failed', reason: abort.signal.aborted ? (abort.signal.reason === 'budget' ? 'budget' : 'interrupted') : 'action_failed', at: position, evidence };
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', stop); abort.signal.removeEventListener('abort', listener);
    await backend.close();
  }
}
