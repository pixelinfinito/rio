import { chromium, devices } from 'playwright';
import { browserControls, contextTools } from './context.mjs';
import { installProbeObserver, ProbeCollector, ProbeRun, builtinProbeRules } from './probes.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const mobileUserAgent = devices['iPhone 13'].userAgent;
const maskStyle = 'input[type="password"]{-webkit-text-security:disc!important}[data-rio-mask]{opacity:0!important}';

/** The app and Chromium start independently. A ready app is not a readiness
 * signal for the remote browser; retry only transient connection startup errors
 * inside the same cell deadline, before any journey action or credential use. */
export async function connectRemoteBrowser(endpoint, { signal, timeoutMs = 30000, connect = (url, options) => chromium.connectOverCDP(url, options) } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    try { return await connect(endpoint, { timeout: Math.max(1, Math.min(5000, deadline - Date.now())) }); }
    catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      if (Date.now() >= deadline || !/ECONNREFUSED|ECONNRESET|socket hang up|ECONNABORTED|connect ETIMEDOUT/.test(String(error?.message))) throw error;
      await delay(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
  }
}

/** Rio owns the context. The harness only receives the restricted MCP facade. */
export async function openBrowser({ endpoint, viewport, viewports = {}, colorScheme = 'light', context = {}, allowedOrigins = [], launchOptions = {}, recordContext = async () => {}, journey = 'exploratory', probeRun, rules = {}, video = false, signal, connectTimeoutMs }) {
  const browser = endpoint ? await connectRemoteBrowser(endpoint, { signal, timeoutMs: connectTimeoutMs }) : await chromium.launch({ headless: true, ...launchOptions });
  let session, videoDirectory;
  try {
    if (video) videoDirectory = await mkdtemp(join(tmpdir(), 'rio-private-video-'));
    session = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.device_scale_factor || 1,
      isMobile: viewport.mobile, hasTouch: viewport.touch,
      userAgent: viewport.user_agent || (viewport.mobile ? mobileUserAgent : undefined),
      // The controller's CDP sessions own locale/timezone overrides so a
      // dependent can update them without replacing the browser context.
      colorScheme,
      geolocation: context.geolocation,
      permissions: context.geolocation ? ['geolocation'] : [],
      serviceWorkers: 'block',
      ...(videoDirectory ? { recordVideo: { dir: videoDirectory, size: { width: viewport.width, height: viewport.height } } } : {}),
    });
    const consoleEvents = [], networkEvents = [];
    await installProbeObserver(session);
    const origins = new Set(allowedOrigins);
    // Defense in depth; the pod's network firewall remains the enforcement boundary.
    await session.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (origins.size && !origins.has(url.origin)) {
        networkEvents.push({ kind: 'blocked_egress', host: url.hostname });
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    await session.addInitScript(style => {
      const watch = root => {
        const install = () => {
          const parent = root === document ? document.documentElement : root;
          if (!parent || root.querySelector('style[data-rio-mask-style]')) return;
          const element = document.createElement('style'); element.dataset.rioMaskStyle = ''; element.textContent = style;
          parent.append(element);
        };
        new MutationObserver(install).observe(root, { childList: true, subtree: true }); install();
      };
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(options) { const root = attach.call(this, options); watch(root); return root; };
      watch(document);
    }, maskStyle);
    const pendingNetwork = new Set();
    session.on('page', page => {
      page.on('console', message => consoleEvents.push({ kind: message.type(), text: message.text(), location: message.location() }));
      page.on('pageerror', error => consoleEvents.push({ kind: 'error', text: error.message, stack: error.stack }));
      page.on('requestfailed', request => networkEvents.push({ kind: 'requestfailed', url: request.url(), error: request.failure()?.errorText }));
      page.on('request', request => {
        const row = { kind: 'request', url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() };
        networkEvents.push(row);
        const work = request.allHeaders().then(headers => { row.headers = headers; }).catch(() => {}).finally(() => pendingNetwork.delete(work));
        pendingNetwork.add(work);
      });
      page.on('response', response => {
        const row = { kind: 'response', url: response.url(), status: response.status(), headers: response.headers(), body_pending: true };
        networkEvents.push(row);
        const work = (async () => {
          row.headers = await response.allHeaders();
          const type = row.headers['content-type'] || '';
          if (/^(?:text\/|application\/(?:json|[^;]+\+json|javascript|xml|[^;]+\+xml))/.test(type)) row.body = (await response.body()).toString('utf8');
          else row.body_omitted = 'binary_or_unspecified_content';
          delete row.body_pending;
        })().catch(() => { delete row.body_pending; row.body_omitted = 'unavailable'; }).finally(() => pendingNetwork.delete(work));
        pendingNetwork.add(work);
      });
    });
    await session.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = await session.newPage();
    const withUserAgent = viewport => ({ ...viewport, user_agent: viewport.user_agent || devices[viewport.mobile ? 'iPhone 13' : 'Desktop Chrome'].userAgent });
    const replayEvents = []; let step = 1, replayJourney = journey;
    const controls = await browserControls(session, { viewport: withUserAgent(viewport),
      viewports: Object.fromEntries(Object.entries(viewports).map(([name, viewport]) => [name, withUserAgent(viewport)])), colorScheme, context,
      record: async (action, args) => {
        const event = { version: 1, sequence: replayEvents.length, journey: replayJourney, step,
          cell: { viewport: viewport.name || (viewport.mobile ? 'mobile' : 'desktop'), color_scheme: colorScheme }, action, arguments: structuredClone(args) };
        replayEvents.push(event); await recordContext(event);
      } });
    const result = {
      browser, context: session, get page() { return session.pages().filter(page => !page.isClosed()).at(-1) || page; }, controls, handlers: contextTools(controls), consoleEvents, networkEvents, replayEvents,
      visualMasking: true,
      async flushNetwork() {
        let timer;
        try { await Promise.race([Promise.allSettled([...pendingNetwork]), new Promise(resolve => { timer = setTimeout(resolve, 250); })]); }
        finally { clearTimeout(timer); }
      },
      async disposeVideo() { if (videoDirectory) await rm(videoDirectory, { recursive: true, force: true }); },
      setReplayStep(value) { if (!Number.isInteger(value) || value < 1) throw new Error('Invalid replay step'); step = value; },
      setReplayJourney(value) { if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new Error('Invalid replay journey'); replayJourney = value; },
      async close({ retainVideo = false } = {}) {
        try { await controls.close(); } finally { try { await session.close(); } finally { await browser.close(); if (!retainVideo && videoDirectory) await rm(videoDirectory, { recursive: true, force: true }); } }
      },
    };
    result.probes = new ProbeCollector(result, probeRun || new ProbeRun({ rules: await builtinProbeRules(), overrides: rules }));
    return result;
  } catch (error) {
    try { await session?.close(); } finally { await browser.close(); if (videoDirectory) await rm(videoDirectory, { recursive: true, force: true }); }
    throw error;
  }
}
