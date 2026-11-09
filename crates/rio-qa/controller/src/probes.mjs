import { readFile } from 'node:fs/promises';
import { measureDom, inspectElement } from './probe-dom.mjs';
import { elementAttribution, stackHints } from './attribution.mjs';

// Rule IDs have no filesystem semantics. Like globset's default matcher, a
// wildcard can span the namespace separator; support its ordinary glob forms.
const glob = pattern => {
  let expression = '^', braces = 0;
  const literal = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') expression += literal(pattern[++i] || '\\');
    else if (char === '*') { expression += '.*'; while (pattern[i + 1] === '*') i++; }
    else if (char === '?') expression += '.';
    else if (char === '[') {
      const end = pattern.indexOf(']', i + (pattern[i + 1] === '!' || pattern[i + 1] === '^' ? 2 : 1));
      if (end < 0) throw new Error('Invalid rule glob');
      let content = pattern.slice(i + 1, end);
      if (content.startsWith('!')) content = '^' + content.slice(1);
      expression += '[' + content + ']'; i = end;
    } else if (char === '{') { expression += '(?:'; braces++; }
    else if (char === '}' && braces) { expression += ')'; braces--; }
    else if (char === ',' && braces) expression += '|';
    else expression += literal(char);
  }
  if (braces) throw new Error('Invalid rule glob');
  return new RegExp(expression + '$');
};
export const matchesRule = (patterns, value) => patterns.some(pattern => glob(pattern).test(value));
const cellKey = cell => JSON.stringify([cell.viewport, cell.color_scheme]);

export async function builtinProbeRules() {
  for (const url of [new URL('../rules/ui-v1.yaml', import.meta.url), new URL('../../../../modules/qa/rules/ui-v1.yaml', import.meta.url)]) {
    try { return JSON.parse(await readFile(url, 'utf8')).rules; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('Built-in QA ruleset is unavailable');
}

/** One accumulator per QA run, shared by every browser cell. */
export class ProbeRun {
  constructor({ rules, overrides = {} }) {
    this.rules = new Map(rules.filter(rule => rule.kind === 'probe').map(rule => [rule.id, rule]));
    this.overrides = overrides; this.samples = new Map(); this.candidates = []; this.gaps = []; this.assessments = []; this.done = false;
    this.consoleFilters = (overrides.ignore_console || []).map(pattern => new RegExp(pattern));
  }
  enabled(id) { return this.rules.has(id) && !matchesRule(this.overrides.disable || [], id); }
  record({ page, frame = 'main', journey, step, cell, evidence, measurements }) {
    if (this.done) throw new Error('Probe run already finalized');
    if (!Number.isInteger(step) || step < 1 || !journey || !cell?.viewport || !cell?.color_scheme) throw new Error('Invalid probe step metadata');
    // Probe measurements alone are not retained as findings without independently
    // captured artifacts; callers cannot turn a harness claim into static proof.
    if (!evidence?.screenshot || !evidence?.dom) throw new Error('Probe step requires screenshot and DOM artifact references');
    const where = { journey, step, cell: structuredClone(cell), page, frame, evidence: structuredClone(evidence) };
    for (const id of Object.keys(measurements.eligible)) {
      if (this.enabled(id) && !measurements.gaps.some(gap => gap.rule_id === id)) {
        this.assessments.push({ rule_id: id, journey, step, cell: structuredClone(cell), scope: this.rules.get(id).scope });
      }
    }
    for (const [id, paths] of Object.entries(measurements.eligible)) {
      if (!this.enabled(id)) continue;
      if (!this.samples.has(id)) this.samples.set(id, new Set());
      // Visiting the same element in another step/scheme must not bias the
      // minority population. A match in any cell makes that element a match.
      for (const path of paths) this.samples.get(id).add(JSON.stringify([page, frame, path]));
    }
    const candidates = measurements.candidates.filter(candidate => this.enabled(candidate.rule_id)).map(candidate => ({ ...candidate, ...where }));
    this.candidates.push(...candidates.filter(candidate => this.rules.get(candidate.rule_id).scope === 'run'));
    this.gaps.push(...measurements.gaps.filter(gap => this.enabled(gap.rule_id)).map(gap => ({ ...gap, ...where })));
    return this.group(candidates.filter(candidate => this.rules.get(candidate.rule_id).scope === 'step'));
  }
  group(candidates, minority) {
    const groups = new Map();
    for (const candidate of candidates) {
      if (!groups.has(candidate.rule_id)) groups.set(candidate.rule_id, []);
      groups.get(candidate.rule_id).push(candidate);
    }
    return [...groups].map(([id, rows]) => {
      const rule = this.rules.get(id), adopted = (this.overrides.adopt || []).includes(id), occurrences = new Map();
      for (const row of rows) {
        const key = cellKey(row.cell);
        if (!occurrences.has(key)) occurrences.set(key, { cell: row.cell, observations: [] });
        occurrences.get(key).observations.push(row);
      }
      return { rule_id: id, kind: rule.category, severity: rule.category === 'style' && !adopted ? 'info' : rule.severity,
        adopted, evidence_level: 'static_proven', scope: rule.scope, occurrences: [...occurrences.values()], ...(minority ? { minority } : {}) };
    });
  }
  finalize() {
    // Calling twice must not emit run-scoped findings twice.
    if (this.done) return { findings: [], summaries: [], gaps: [] };
    this.done = true;
    const findings = [], summaries = [];
    for (const [id, rule] of this.rules) {
      if (!this.enabled(id)) { summaries.push({ rule_id: id, disabled: true }); continue; }
      if (rule.scope !== 'run') continue;
      const rows = this.candidates.filter(candidate => candidate.rule_id === id);
      const population = this.samples.get(id) || new Set();
      const matched = new Set(rows.map(row => JSON.stringify([row.page, row.frame, row.element_path])).filter(key => population.has(key)));
      const minSample = rule.threshold.min_sample ?? 5, threshold = rule.threshold.ratio ?? .2;
      const ratio = population.size ? matched.size / population.size : 0;
      const summary = { rule_id: id, matched: matched.size, eligible: population.size, ratio, threshold, min_sample: minSample,
        pages: [...new Set([...population].map(key => JSON.parse(key)[0]))].sort(), adopted: (this.overrides.adopt || []).includes(id),
        reason: population.size < minSample ? 'below_min_sample' : ratio >= threshold ? 'consistent_usage' : matched.size ? 'minority' : 'no_matches' };
      summaries.push(summary);
      if (summary.reason === 'minority') findings.push(...this.group(rows, summary));
    }
    return { findings, summaries, gaps: this.gaps };
  }
}

export async function installProbeObserver(context) {
  await context.addInitScript(() => {
    const shifts = []; let overflow = 0, available = true;
    Object.defineProperty(globalThis, '__rioQaTakeShifts', { value: () => {
      if (!available) return null;
      const entries = shifts.splice(0);
      if (overflow) entries.push({ value: overflow, aggregated: true });
      overflow = 0; return entries;
    }, configurable: false });
    try {
      new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) {
        if (shifts.length < 1000) shifts.push({ value: entry.value, start_time: entry.startTime }); else overflow += entry.value;
      } }).observe({ type: 'layout-shift', buffered: true });
    } catch { available = false; }
  });
}

// Chromium pseudo-class forcing inspects focus/hover styling without dispatching
// repository focus handlers or activating controls. Always undo in finally.
async function queryNode(session, root, path) {
  const parts = path.split(' >>> ');
  for (let i = 0; i < parts.length; i++) {
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: root, selector: parts[i] });
    if (!nodeId) throw new Error('Probe element detached');
    if (i === parts.length - 1) return nodeId;
    const { node } = await session.send('DOM.describeNode', { nodeId, depth: 1, pierce: true });
    root = node.shadowRoots?.find(root => root.shadowRootType === 'open')?.nodeId;
    if (!root) throw new Error('Probe shadow root detached');
  }
}

async function frameRoot(session, frame, page) {
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  if (frame === page.mainFrame()) return root.nodeId;
  const chain = []; let current = frame;
  while (current.parentFrame()) {
    const element = await current.frameElement();
    try {
      chain.unshift(await element.evaluate(el => {
        const path = el => { const parts = []; while (el?.nodeType === 1) { const index = [...el.parentNode.children].filter(sibling => sibling.localName === el.localName).indexOf(el) + 1; parts.unshift(`${CSS.escape(el.localName)}:nth-of-type(${index})`); if (el.parentNode instanceof ShadowRoot) return path(el.parentNode.host) + ' >>> ' + parts.join(' > '); el = el.parentElement; } return parts.join(' > '); };
        return path(el);
      }));
    } finally { await element.dispose(); }
    current = current.parentFrame();
  }
  let nodeId = root.nodeId;
  for (const path of chain) {
    const owner = await queryNode(session, nodeId, path);
    const { node } = await session.send('DOM.describeNode', { nodeId: owner, depth: 1, pierce: true });
    if (!node.contentDocument) throw new Error('Frame requires a separate CDP target');
    nodeId = node.contentDocument.nodeId;
  }
  return nodeId;
}

async function dynamicProbes(page, frame, measurements, enabled) {
  let session, root;
  try {
    // Out-of-process frames have their own target. Same-process frames are
    // addressed through the page's DOM tree instead.
    if (frame !== page.mainFrame()) {
      try { session = await page.context().newCDPSession(frame); root = (await session.send('DOM.getDocument', { depth: -1, pierce: true })).root.nodeId; } catch { await session?.detach(); session = undefined; }
    }
    if (!session) { session = await page.context().newCDPSession(page); root = await frameRoot(session, frame, page); }
    await session.send('CSS.enable');
    if (enabled('mobile/offscreen-content')) for (const path of measurements.offscreenFocus || []) {
      let nodeId;
      try {
        nodeId = await queryNode(session, root, path);
        await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
        const [focused] = await frame.evaluate(inspectElement, { path });
        if (focused?.visible && focused.in_viewport) measurements.candidates = measurements.candidates.filter(row => row.rule_id !== 'mobile/offscreen-content' || row.element_path !== path);
      } catch {
        measurements.candidates = measurements.candidates.filter(row => row.rule_id !== 'mobile/offscreen-content' || row.element_path !== path);
        measurements.gaps.push({ rule_id: 'mobile/offscreen-content', element_path: path, reason: 'focus_reveal_inspection_failed' });
      } finally { if (nodeId) await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {}); }
    }
    if (enabled('ui/missing-focus-style')) for (const target of measurements.focus) {
      let nodeId;
      try {
        nodeId = await queryNode(session, root, target.element_path);
        await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
        const before = await frame.evaluate(inspectElement, { path: target.element_path });
        if (before[0]?.focused) { measurements.gaps.push({ rule_id: 'ui/missing-focus-style', element_path: target.element_path, reason: 'already_focused' }); continue; }
        await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
        const after = await frame.evaluate(inspectElement, { path: target.element_path });
        if (before.length && after.length && JSON.stringify(before[0].styles) === JSON.stringify(after[0].styles)) measurements.candidates.push({ rule_id: 'ui/missing-focus-style', ...target, measurements: { focus_visible_styles_equal: true }, related_paths: [] });
      } catch { measurements.gaps.push({ rule_id: 'ui/missing-focus-style', element_path: target.element_path, reason: 'focus_inspection_failed' }); }
      finally { if (nodeId) await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {}); }
    }
    if (enabled('mobile/hover-only')) for (const target of measurements.hover) {
      let nodeId;
      try {
        nodeId = await queryNode(session, root, target.trigger_path);
        const inspect = () => frame.evaluate(inspectElement, { selector: target.target_selector });
        const before = await inspect();
        await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
        const hovered = await inspect();
        await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible', 'focus-within', 'active'] });
        const focused = await inspect();
        const revealed = before.map((state, index) => !state.visible && hovered[index]?.visible && !focused[index]?.visible).some(Boolean);
        if (revealed) {
          const { object } = await session.send('DOM.resolveNode', { nodeId });
          const { result: chain } = await session.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function(){const a=[];let e=this;while(e){a.push(e);e=e.parentNode||e.host;}a.push(window);return a;}', returnByValue: false });
          const { result: properties } = await session.send('Runtime.getProperties', { objectId: chain.objectId, ownProperties: true });
          let touchEquivalent = false;
          try {
            for (const entry of properties.filter(entry => /^\d+$/.test(entry.name))) {
              const { listeners } = await session.send('DOMDebugger.getEventListeners', { objectId: entry.value.objectId });
              if (listeners.some(listener => /^(click|pointerdown|pointerup|touchstart|touchend)$/.test(listener.type))) touchEquivalent = true;
            }
          } finally { await session.send('Runtime.releaseObject', { objectId: chain.objectId }); await session.send('Runtime.releaseObject', { objectId: object.objectId }); }
          // A delegated handler could supply a touch path. Its mere presence
          // is uncertainty, not proof that touch works or that it cannot work.
          if (touchEquivalent) measurements.gaps.push({ rule_id: 'mobile/hover-only', element_path: target.trigger_path, reason: 'touch_handler_requires_interaction' });
          else measurements.candidates.push({ rule_id: 'mobile/hover-only', element_path: target.trigger_path, role_signature: { role: 'hover-trigger' }, measurements: { selector: target.selector, revealed_on_hover: true, revealed_on_focus: false, touch_handlers: false }, related_paths: [] });
        }
      } catch { measurements.gaps.push({ rule_id: 'mobile/hover-only', element_path: target.trigger_path, reason: 'hover_inspection_failed' }); }
      finally { if (nodeId) await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {}); }
    }
  } catch {
    for (const id of ['ui/missing-focus-style', 'mobile/hover-only']) if (enabled(id)) measurements.gaps.push({ rule_id: id, reason: 'cdp_inspection_unavailable' });
    if (enabled('mobile/offscreen-content')) for (const path of measurements.offscreenFocus || []) {
      measurements.candidates = measurements.candidates.filter(row => row.rule_id !== 'mobile/offscreen-content' || row.element_path !== path);
      measurements.gaps.push({ rule_id: 'mobile/offscreen-content', element_path: path, reason: 'focus_reveal_inspection_failed' });
    }
  } finally { await session?.detach(); }
}

/** Per-cell event cursors; the accumulator itself spans the whole run. */
export class ProbeCollector {
  constructor(browser, run) { this.browser = browser; this.run = run; this.consoleOffset = 0; this.networkOffset = 0; this.failedRequests = new Map(); this.steps = new Set(); }
  async collect({ page = this.browser.page, journey, step, cell, viewport, evidence }) {
    const key = JSON.stringify([journey, step, cellKey(cell)]);
    if (this.steps.has(key)) throw new Error('Probe step was already collected');
    const consoleEvents = this.browser.consoleEvents.slice(this.consoleOffset), networkEvents = this.browser.networkEvents.slice(this.networkOffset);
    for (const event of networkEvents) {
      if (event.kind === 'requestfailed' || event.status >= 400) this.failedRequests.set(event.url, event);
      else if (event.kind === 'response') this.failedRequests.delete(event.url);
    }
    const failedImages = [...this.failedRequests.keys()];
    const findings = [];
    for (const [index, frame] of page.frames().entries()) {
      const mobile = Boolean(viewport.mobile || viewport.touch);
      const measured = await frame.evaluate(measureDom, { mobile, failedImages });
      for (const candidate of measured.candidates) if (candidate.rule_id === 'ui/broken-image') {
        const urls = candidate.measurements.source ? [candidate.measurements.source] : candidate.measurements.failed_background_requests;
        candidate.measurements.failed_requests = urls.map(url => this.failedRequests.get(url)).filter(Boolean);
      }
      await dynamicProbes(page, frame, measured, id => this.run.enabled(id) && (mobile || !id.startsWith('mobile/')));
      const shifts = await frame.evaluate(() => typeof globalThis.__rioQaTakeShifts === 'function' ? globalThis.__rioQaTakeShifts() : null);
      if (shifts === null) measured.gaps.push({ rule_id: 'ui/layout-shift', reason: 'observer_unavailable' });
      else {
        const cls = shifts.reduce((sum, shift) => sum + shift.value, 0);
        if (cls > .1) measured.candidates.push({ rule_id: 'ui/layout-shift', element_path: 'html', role_signature: { role: 'document' }, measurements: { cumulative_layout_shift: cls, threshold: .1, entries: shifts }, related_paths: [] });
      }
      if (index === 0) for (const event of consoleEvents) if (event.kind === 'error' && !this.run.consoleFilters.some(pattern => pattern.test(event.text))) measured.candidates.push({ rule_id: 'ui/console-error', element_path: 'html', role_signature: { role: 'document' }, measurements: { message: event.text }, related_paths: [] });
      const hints = await frame.evaluate(elementAttribution, measured.candidates.map(candidate => candidate.element_path));
      measured.candidates.forEach((candidate, index) => { candidate.attribution = { ...hints[index], stack: stackHints(consoleEvents) }; });
      findings.push(...this.run.record({ page: frame.url(), frame: String(index), journey, step, cell, evidence, measurements: measured }));
    }
    this.steps.add(key); this.consoleOffset += consoleEvents.length; this.networkOffset += networkEvents.length;
    return findings;
  }
}
