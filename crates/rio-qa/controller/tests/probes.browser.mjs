import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { openBrowser } from '../src/browser.mjs';
import { measureDom } from '../src/probe-dom.mjs';
import { ProbeRun, builtinProbeRules } from '../src/probes.mjs';

const viewport = { name: 'mobile', width: 390, height: 844, mobile: true, touch: true, device_scale_factor: 1 };
const cell = { viewport: 'mobile', color_scheme: 'light' };
const start = options => openBrowser({ viewport, ...options });
const documentOf = (body, css = '') => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:white;color:black}${css}</style>${body}`;
const candidates = (result, id) => result.candidates.filter(row => row.rule_id === id);
const measure = browser => browser.page.evaluate(measureDom, { mobile: true });
async function collect(browser, step = 1, target = browser.page) {
  // The probe API accepts references from the evidence sink, never the harness.
  const png = await target.screenshot(); assert.ok(png.byteLength > 100);
  const dom = await target.content(); assert.ok(dom.includes('<html'));
  return browser.probes.collect({ page: target, journey: 'checkout', step, cell, viewport, evidence: { screenshot: `step-${step}.png`, dom: `step-${step}.dom.json` } });
}

test('gradient, card, raw primitive, spacing and type predicates measure their specified populations', async () => {
  const browser = await start();
  try {
    await browser.page.setContent(documentOf('<header>Hero</header><canvas></canvas><div class="cards">' + '<article>Card</article>'.repeat(4) + '</div>' + '<button class="styled">Save</button>'.repeat(9) + '<button>Raw</button><div class="siblings"><div>A</div><div>B</div><div class="odd">C</div></div><div class="text">' + '<span>Text</span>'.repeat(100) + '<label>Off-scale</label></div>', `
      header{height:340px;background:linear-gradient(red,blue)} canvas{height:350px;width:390px;background:linear-gradient(red,blue)}
      article{height:170px;width:380px;border:1px solid grey;border-left:4px solid blue;border-radius:8px}
      button.styled{appearance:none;border:0;background:#345;color:white;font:18px sans-serif;padding:8px}
      .siblings>div{padding:8px;margin:8px}.siblings>.odd{padding-left:13px}
      .text span{font-size:16px}.text label{font-size:15px}
    `));
    const result = await measure(browser);
    assert.equal(candidates(result, 'ui/gradient-background').length, 1);
    assert.ok(candidates(result, 'ui/gradient-background')[0].measurements.area_ratio > .4);
    assert.equal(candidates(result, 'ui/accent-border-card').length, 4);
    assert.equal(candidates(result, 'ui/raw-primitive').length, 1);
    assert.equal(candidates(result, 'ui/raw-primitive')[0].measurements.styled_ratio, .9);
    assert.ok(candidates(result, 'ui/spacing-scale').some(row => row.measurements.values.includes(13)));
    const type = candidates(result, 'ui/type-scale').find(row => row.measurements.font_size === 15);
    assert.equal(type.measurements.nearest_common_size, 16);
    assert.ok(type.measurements.usage_ratio < .02);
    assert.ok(!result.eligible['ui/gradient-background'].some(path => path.includes('canvas')));
  } finally { await browser.close(); }
});

test('contrast uses composited colors and large text thresholds, with gaps for uncertain backgrounds', async () => {
  const browser = await start();
  try {
    await browser.page.setContent(documentOf('<p id="low">Body copy</p><p id="large">Large copy</p><p class="alpha">Composited</p><p class="gradient">Uncertain</p>', 'body{background:#1a1a1a;color:#777}p{font-size:16px}#large{font-size:24px}.alpha{background:rgba(255,255,255,.5);color:rgba(0,0,0,.1)}.gradient{background:linear-gradient(white,black)}'));
    const result = await measure(browser), low = candidates(result, 'ui/low-contrast');
    assert.equal(low.length, 2);
    assert.ok(low.some(row => row.measurements.threshold === 4.5 && row.measurements.ratio > 3 && row.measurements.ratio < 4.5));
    assert.ok(low.every(row => row.measurements.font_size === 16));
    assert.ok(result.gaps.some(row => row.rule_id === 'ui/low-contrast' && row.reason === 'non_uniform_or_unresolved_background'));
  } finally { await browser.close(); }
});

test('mobile dimensions, clipping, overflow, meta and fixed occlusion have concrete measurements', async () => {
  const browser = await start();
  try {
    await browser.page.setContent(documentOf('<nav>' + '<button>+</button>'.repeat(5) + '</nav><input type="email"><div class="wide">Wide table</div><p class="clip">This is deliberately much wider than the box</p><p class="ellipsis">This is deliberately much wider than the box</p><button id="pay">Pay</button><footer>Cookies</footer><span class="offscreen">Unreachable</span>', `
      nav{display:flex;gap:4px}nav button{width:28px;height:28px;padding:0}input{font-size:14px}
      .wide{width:420px}.clip,.ellipsis{overflow:hidden;width:60px;white-space:nowrap}.ellipsis{text-overflow:ellipsis}
      #pay{position:absolute;bottom:20px;left:50px;width:100px;height:50px}footer{position:fixed;bottom:0;height:90px;width:100%;background:grey}.offscreen{position:fixed;left:-200px;top:0}
    `));
    const result = await measure(browser);
    assert.equal(candidates(result, 'mobile/tap-target').filter(row => row.measurements.box.width === 28).length, 5);
    assert.equal(candidates(result, 'mobile/input-zoom')[0].measurements.font_size, 14);
    assert.equal(candidates(result, 'mobile/input-zoom')[0].measurements.safari_zoom_reproduced, false);
    const overflow = candidates(result, 'ui/horizontal-overflow')[0].measurements;
    assert.equal(overflow.viewport_width, 390);
    assert.equal(overflow.excess, overflow.scroll_width - 390);
    assert.ok(overflow.excess >= 30);
    assert.equal(candidates(result, 'mobile/text-truncation').length, 1);
    assert.ok(candidates(result, 'mobile/offscreen-content').length > 0);
    assert.ok(candidates(result, 'mobile/fixed-overlap')[0].related_paths.some(path => path.includes('button')));
    assert.equal(candidates(result, 'mobile/viewport-meta').length, 0);
    const desktop = await browser.page.evaluate(measureDom, { mobile: false });
    assert.ok(desktop.candidates.every(row => !row.rule_id.startsWith('mobile/')));
    // Prevent Chromium's automatic scale rounding from widening scrollWidth
    // by one pixel, so this fixture measures exactly the specified 420px.
    await browser.page.setContent(documentOf('<div style="width:420px">Table</div>').replace('initial-scale=1', 'initial-scale=1,minimum-scale=1'));
    assert.equal(candidates(await measure(browser), 'ui/horizontal-overflow')[0].measurements.excess, 30);
    await browser.page.locator('meta[name=viewport]').evaluate(element => element.remove());
    assert.equal(candidates(await measure(browser), 'mobile/viewport-meta').length, 1);
  } finally { await browser.close(); }
});

test('offscreen content permits document and nested scrolling and only exempts skip links that reveal on focus', async () => {
  const browser = await start();
  try {
    await browser.page.setContent(documentOf(`<a class="skip" href="#main">Skip to main</a><a class="broken" href="#main">Broken skip</a>
      <main id="main"><div class="scroll"><div class="space"></div><button>Scrollable action</button></div>
      <div class="clip"><button>Clipped action</button></div><button class="fixed">Unreachable fixed action</button>
      <div class="space"></div><footer>Ordinary below-the-fold footer</footer></main>`, `
      .skip,.broken{position:absolute;left:0;top:-100px}.skip:focus{top:0}
      .scroll{overflow:auto;height:100px;width:200px}.space{height:1200px}
      .clip{overflow:hidden;height:40px;width:200px}.clip button{margin-top:100px}
      .fixed{position:fixed;left:-200px;top:50px}
    `));
    await browser.page.evaluate(() => { window.focusEvents = 0; document.addEventListener('focusin', () => window.focusEvents++); });
    const findings = await collect(browser);
    const offscreen = findings.filter(row => row.rule_id === 'mobile/offscreen-content').flatMap(row => row.occurrences.flatMap(occurrence => occurrence.observations));
    assert.deepEqual(offscreen.map(row => row.role_signature.name).sort(), ['Broken skip', 'Clipped action', 'Unreachable fixed action']);
    assert.equal(await browser.page.evaluate(() => window.focusEvents), 0);
    assert.equal(await browser.page.locator('.skip').evaluate(el => el.getBoundingClientRect().y), -100);
    await browser.page.evaluate(() => { window.scrollTo(0, 900); document.querySelector('.scroll').scrollTop = 900; });
    const scrolled = candidates(await measure(browser), 'mobile/offscreen-content');
    assert.ok(!scrolled.some(row => row.role_signature.name === 'Scrollable action' || row.element_path.includes('footer')));
    await browser.page.setContent(documentOf('<div class="scroll"><div class="wide"><button>Horizontal action</button></div></div><button class="below">Locked document action</button>', `
      body{overflow:hidden}.scroll{overflow:auto;width:200px}.wide{width:1000px;display:flex;justify-content:end}
      .below{position:absolute;top:1200px}
    `));
    await browser.page.evaluate(() => window.scrollTo(0, 0));
    assert.deepEqual(candidates(await measure(browser), 'mobile/offscreen-content').map(row => row.role_signature.name), ['Locked document action']);
    await browser.page.locator('.scroll').evaluate(el => { el.scrollLeft = 500; });
    assert.deepEqual(candidates(await measure(browser), 'mobile/offscreen-content').map(row => row.role_signature.name), ['Locked document action']);
  } finally { await browser.close(); }
});

test('real focus and hover checks do not trigger application focus handlers and restore pseudo states', async () => {
  const browser = await start();
  try {
    await browser.page.setContent(documentOf('<button id="bad">No focus</button><button id="good">Focus</button><div class="menu" tabindex="0">Menu<div class="submenu">Account</div></div><div class="accessible" tabindex="0">Menu<div class="submenu">Account</div></div><div class="touch" tabindex="0">Menu<div class="submenu">Account</div></div>', `
      button,[tabindex]{outline:none;box-shadow:none}#good:focus-visible{outline:3px solid blue}
      .submenu{display:none}.menu:hover>.submenu,.accessible:hover>.submenu,.accessible:focus-within>.submenu,.touch:hover>.submenu{display:block}
    `));
    await browser.page.evaluate(() => { window.focusEvents = 0; document.addEventListener('focusin', () => window.focusEvents++); document.querySelector('.touch').addEventListener('click', () => {}); });
    const findings = await collect(browser);
    const focus = findings.find(row => row.rule_id === 'ui/missing-focus-style');
    assert.ok(focus, JSON.stringify(browser.probes.run.gaps));
    assert.ok(focus.occurrences[0].observations.some(row => row.element_path.endsWith('button:nth-of-type(1)')));
    assert.ok(focus.occurrences[0].observations.every(row => !row.element_path.endsWith('button:nth-of-type(2)')));
    const hover = findings.find(row => row.rule_id === 'mobile/hover-only');
    assert.equal(hover?.occurrences[0].observations.length, 1, JSON.stringify(browser.probes.run.gaps));
    assert.ok(browser.probes.run.gaps.some(row => row.reason === 'touch_handler_requires_interaction'));
    assert.equal(await browser.page.evaluate(() => window.focusEvents), 0);
    assert.equal(await browser.page.locator('.menu .submenu').isVisible(), false);
    assert.equal(await browser.page.locator('#good').evaluate(element => getComputedStyle(element).outlineStyle), 'none');
    await browser.page.locator('#bad').focus();
    const afterFocus = await collect(browser, 2);
    assert.ok(afterFocus.filter(row => row.rule_id === 'ui/missing-focus-style').flatMap(row => row.occurrences[0].observations).every(row => !row.element_path.endsWith('button:nth-of-type(1)')));
    assert.ok(browser.probes.run.gaps.some(row => row.reason === 'already_focused'));
  } finally { await browser.close(); }
});

test('console exceptions, failed images and actual layout shifts are attributed to one step', async () => {
  const server = createServer((request, response) => {
    if (request.url !== '/') { response.statusCode = 404; response.end('missing'); return; }
    response.setHeader('content-type', 'text/html');
    response.end(documentOf('<div id="space"></div><p>Moves down</p><img width="30" height="30" src="/missing.png"><div class="background"></div>', 'p{height:300px;background:red}.background{width:30px;height:30px;background-image:url(/missing-bg.png)}'));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await start({ rules: { ignore_console: ['^Known (warning|notice) .*'] } });
  try {
    await browser.page.goto(`http://127.0.0.1:${server.address().port}`);
    await browser.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Layout shifts within the browser's recent-input grace period are not CLS.
    await browser.page.waitForTimeout(600);
    await browser.page.evaluate(() => { document.querySelector('#space').style.height = '300px'; console.error('Known warning ignored'); console.error('payment failed'); setTimeout(() => { throw new Error('uncaught checkout'); }, 0); });
    await browser.page.waitForFunction(() => document.querySelector('p').getBoundingClientRect().top > 290);
    await browser.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    const findings = await collect(browser);
    const errors = findings.find(row => row.rule_id === 'ui/console-error').occurrences[0].observations.map(row => row.measurements.message);
    assert.ok(errors.some(message => message === 'payment failed'));
    assert.ok(errors.some(message => message.includes('uncaught checkout')));
    assert.ok(errors.every(message => !message.startsWith('Known warning')));
    const images = findings.find(row => row.rule_id === 'ui/broken-image');
    assert.equal(images.occurrences[0].observations.length, 2);
    assert.ok(images.occurrences[0].observations.every(row => row.measurements.failed_requests[0]?.status === 404));
    const shift = findings.find(row => row.rule_id === 'ui/layout-shift');
    assert.ok(shift?.occurrences[0].observations[0].measurements.cumulative_layout_shift > .1);
    assert.ok(findings.every(row => row.evidence_level === 'static_proven' && row.occurrences[0].observations[0].evidence.screenshot));
    const second = await collect(browser, 2);
    assert.ok(second.every(row => !['ui/console-error', 'ui/layout-shift'].includes(row.rule_id)));
    assert.equal(second.find(row => row.rule_id === 'ui/broken-image').occurrences[0].observations.length, 2);
    await assert.rejects(collect(browser, 2), /already collected/);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});

test('frames and open shadow DOM are measured and focus styles inspected', async () => {
  const browser = await start();
  try {
    await browser.page.setContent(documentOf('<iframe></iframe><div id="host"></div>'));
    await browser.page.locator('iframe').evaluate(element => { element.srcdoc = '<style>button{outline:none}</style><button>Frame action</button>'; });
    const frame = browser.page.frames()[1]; await frame.waitForSelector('button');
    await browser.page.locator('#host').evaluate(host => { host.attachShadow({ mode: 'open' }).innerHTML = '<style>button{outline:none}</style><button>Shadow action</button>'; });
    const findings = await collect(browser);
    const focus = findings.filter(row => row.rule_id === 'ui/missing-focus-style').flatMap(row => row.occurrences.flatMap(occurrence => occurrence.observations));
    assert.ok(focus.some(row => row.frame === '1'), JSON.stringify(browser.probes.run.gaps));
    assert.ok(focus.some(row => row.element_path.includes(' >>> ')), JSON.stringify(browser.probes.run.gaps));
  } finally { await browser.close(); }
});

test('run-scoped minority uses unique page elements across steps and cells, emits once and respects adoption', async () => {
  const rules = await builtinProbeRules(), run = new ProbeRun({ rules, overrides: { adopt: ['ui/gradient-background'], disable: ['mobile/*'] } });
  const browser = await start({ probeRun: run });
  try {
    await browser.page.setContent(documentOf('<section class="gradient">Hero</section>' + '<section>Plain</section>'.repeat(8), 'section{height:300px}.gradient{background:linear-gradient(red,blue)}'));
    for (const step of [1, 2, 3]) assert.ok((await collect(browser, step)).every(row => row.scope === 'step' && !row.rule_id.startsWith('mobile/')));
    const measured = await measure(browser);
    run.record({ page: browser.page.url(), frame: '0', journey: 'checkout', step: 1, cell: { viewport: 'desktop', color_scheme: 'dark' }, evidence: { screenshot: 'desktop.png', dom: 'desktop.json' }, measurements: measured });
    const result = run.finalize(), finding = result.findings.find(row => row.rule_id === 'ui/gradient-background');
    assert.equal(finding.severity, 'warning'); assert.equal(finding.adopted, true);
    assert.equal(finding.occurrences.length, 2);
    assert.equal(finding.minority.matched, 1);
    assert.equal(finding.minority.eligible, measured.eligible['ui/gradient-background'].length);
    assert.deepEqual(run.finalize().findings, []);
    const unadopted = new ProbeRun({ rules });
    unadopted.record({ page: 'http://app/', journey: 'checkout', step: 1, cell, evidence: { screenshot: 'a.png', dom: 'a.json' }, measurements: measured });
    assert.equal(unadopted.finalize().findings.find(row => row.rule_id === 'ui/gradient-background').severity, 'info');
  } finally { await browser.close(); }
});

test('consistent gradients and too few cards are suppressed with explicit ratios and sample counts', async () => {
  const browser = await start();
  try {
    await browser.page.setContent(documentOf('<section></section>'.repeat(5), 'html,body,section{min-height:300px;background:linear-gradient(red,blue)}'));
    await collect(browser);
    const all = browser.probes.run.finalize();
    assert.ok(all.findings.every(row => row.rule_id !== 'ui/gradient-background'));
    assert.equal(all.summaries.find(row => row.rule_id === 'ui/gradient-background').ratio, 1);
    browser.probes.run = new ProbeRun({ rules: await builtinProbeRules() });
    await browser.page.setContent(documentOf('<article></article>'.repeat(3), 'article{height:170px;border:1px solid grey;border-left:4px solid blue;border-radius:8px}'));
    await collect(browser, 2);
    const small = browser.probes.run.finalize();
    assert.ok(small.findings.every(row => row.rule_id !== 'ui/accent-border-card'));
    assert.equal(small.summaries.find(row => row.rule_id === 'ui/accent-border-card').reason, 'below_min_sample');
    assert.equal(small.summaries.find(row => row.rule_id === 'ui/accent-border-card').eligible, 3);
  } finally { await browser.close(); }
});
