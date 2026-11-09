/** Resolve browser defaults before opening a cell. Repository context cannot
 * change tool permissions, budgets, or the pod's network firewall. */
export function resolveContext(defaults = {}, journey = {}) {
  // Rust's optional context fields serialize as null; null means unspecified.
  const context = Object.fromEntries(Object.entries({ ...defaults, ...Object.fromEntries(Object.entries(journey).filter(([, value]) => value != null)) }).filter(([, value]) => value != null));
  if (context.geolocation) context.geolocation = Object.fromEntries(Object.entries(context.geolocation).filter(([, value]) => value != null));
  return context;
}

export function fixedTimeKey(time) {
  if (time == null) return null;
  const match = typeof time === 'string' && /^(\d{4}-\d\d-\d\d[Tt]\d\d:\d\d:[0-5]\d)(?:\.(\d{1,9}))?([Zz]|[+-]\d\d:\d\d)$/.exec(time);
  if (!match || !Number.isFinite(Date.parse(time))) throw new Error('Invalid fixed time');
  // Date.parse silently normalizes impossible calendar dates, so check the
  // local date/time separately before applying its explicit UTC offset.
  const wall = new Date(match[1] + 'Z').toISOString().slice(0, 19);
  if (wall !== match[1].replace('t', 'T')) throw new Error('Invalid fixed time');
  return (BigInt(Date.parse(match[1] + match[3])) * 1000000n + BigInt((match[2] || '').padEnd(9, '0'))).toString();
}

export function chainContexts(chain, journeys, defaults = {}) {
  const contexts = Object.fromEntries(chain.journeys.map(name => {
    if (!journeys[name]) throw new Error(`Unknown chain journey: ${name}`);
    const context = resolveContext(defaults, journeys[name].context || {});
    contextEnvironment(context); return [name, context];
  }));
  const times = new Set(Object.values(contexts).map(context => fixedTimeKey(context.time)));
  if (times.size > 1) throw new Error('Incompatible chain times: every journey must resolve to the same fixed instant or all use live time');
  return contexts;
}

export function contextEnvironment(context = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).some(key => !['time', 'timezone', 'locale', 'geolocation', 'network'].includes(key))) throw new Error('Invalid controlled context');
  fixedTimeKey(context.time);
  if (context.network !== undefined && !['online', 'slow-3g', 'offline'].includes(context.network)) throw new Error('Invalid network condition');
  if (context.timezone !== undefined) new Intl.DateTimeFormat('en', { timeZone: context.timezone });
  if (context.locale !== undefined) new Intl.Locale(context.locale);
  if (context.geolocation !== undefined) {
    const location = context.geolocation;
    if (!location || !Number.isFinite(location.latitude) || Math.abs(location.latitude) > 90 || !Number.isFinite(location.longitude) || Math.abs(location.longitude) > 180
      || (location.accuracy !== undefined && (!Number.isFinite(location.accuracy) || location.accuracy < 0))) throw new Error('Invalid geolocation');
  }
  return context.time ? { QA_FAKE_TIME: new Date(context.time).toISOString() } : {};
}

/** Mutable conditions stay inside the existing browser context so changing
 * orientation or going offline cannot erase the chain's cookies and cart. */
export async function browserControls(session, { context = {}, viewport, colorScheme = 'light', viewports = {}, record = async () => {} } = {}) {
  contextEnvironment(context);
  let current = { ...context }, selected = viewport, scheme = colorScheme;
  const sessions = new Map();
  const cdpFor = async page => {
    if (!sessions.has(page)) sessions.set(page, await session.newCDPSession(page));
    return sessions.get(page);
  };
  const apply = async page => {
    const cdp = await cdpFor(page);
    await cdp.send('Network.enable');
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: current.timezone || 'UTC' });
    await cdp.send('Emulation.setLocaleOverride', { locale: current.locale || 'en-US' });
    if (selected.user_agent) await cdp.send('Network.setUserAgentOverride', { userAgent: selected.user_agent, acceptLanguage: current.locale || 'en-US' });
    await cdp.send('Network.emulateNetworkConditions', { offline: current.network === 'offline', latency: current.network === 'slow-3g' ? 400 : 0,
      downloadThroughput: current.network === 'slow-3g' ? 50000 : -1, uploadThroughput: current.network === 'slow-3g' ? 50000 : -1 });
    await page.setViewportSize({ width: selected.width, height: selected.height });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: selected.width, height: selected.height,
      screenWidth: selected.width, screenHeight: selected.height, deviceScaleFactor: selected.device_scale_factor || 1,
      mobile: selected.mobile, screenOrientation: { type: selected.orientation === 'landscape' ? 'landscapePrimary' : 'portraitPrimary', angle: selected.orientation === 'landscape' ? 90 : 0 } });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: selected.touch, maxTouchPoints: selected.touch ? 5 : 1 });
    await page.emulateMedia({ colorScheme: scheme });
    if (current.time) await page.clock.setFixedTime(new Date(current.time));
  };
  await session.setOffline(current.network === 'offline');
  if (current.geolocation) { await session.grantPermissions(['geolocation']); await session.setGeolocation(current.geolocation); }
  for (const page of session.pages()) await apply(page);
  const pending = new Set();
  const errors = [];
  const onPage = page => {
    const work = apply(page).catch(error => { errors.push(error); }).finally(() => pending.delete(work));
    pending.add(work);
  };
  session.on('page', onPage);
  const ready = async () => { await Promise.all([...pending]); if (errors.length) throw errors.shift(); };
  await record('set_context', { context: current });
  return {
    ready,
    get state() { return { context: structuredClone(current), viewport: structuredClone(selected), colorScheme: scheme }; },
    async context(next) {
      contextEnvironment(next);
      if (fixedTimeKey(next.time) !== fixedTimeKey(current.time)) throw new Error('Incompatible chain times: changing app time requires a new chain');
      await ready(); current = structuredClone(next);
      await session.setOffline(current.network === 'offline');
      await session.setGeolocation(current.geolocation || null);
      if (current.geolocation) await session.grantPermissions(['geolocation']);
      for (const page of session.pages()) await apply(page);
      await record('set_context', { context: current });
    },
    async network(network) {
      if (!['online', 'slow-3g', 'offline'].includes(network)) throw new Error('Unknown network condition');
      await ready(); current.network = network;
      await session.setOffline(network === 'offline');
      for (const page of session.pages()) await apply(page);
      await record('set_network', { network });
    },
    async geolocation(geolocation) {
      if (!Number.isFinite(geolocation.latitude) || Math.abs(geolocation.latitude) > 90 || !Number.isFinite(geolocation.longitude) || Math.abs(geolocation.longitude) > 180) throw new Error('Invalid geolocation');
      await ready();
      await session.grantPermissions(['geolocation']); await session.setGeolocation(geolocation);
      current.geolocation = { ...geolocation }; await record('set_geolocation', { geolocation });
    },
    async viewport(name) {
      if (!Object.hasOwn(viewports, name)) throw new Error('Undeclared viewport');
      await ready(); selected = viewports[name];
      for (const page of session.pages()) await apply(page);
      await record('set_viewport', { name });
    },
    async colorScheme(color_scheme) {
      if (!['light', 'dark'].includes(color_scheme)) throw new Error('Unknown color scheme');
      await ready(); scheme = color_scheme;
      for (const page of session.pages()) await page.emulateMedia({ colorScheme: scheme });
      await record('set_color_scheme', { color_scheme });
    },
    async close() { session.off('page', onPage); await Promise.all([...pending]); for (const cdp of sessions.values()) { try { await cdp.detach(); } catch {} } },
  };
}

export function contextTools(controls) {
  const result = () => ({ content: [{ type: 'text', text: 'Browser context updated.' }] });
  return {
    set_network: async ({ network }) => { await controls.network(network); return result(); },
    set_geolocation: async geolocation => { await controls.geolocation(geolocation); return result(); },
    set_viewport: async ({ viewport }) => { await controls.viewport(viewport); return result(); },
    set_color_scheme: async ({ color_scheme }) => { await controls.colorScheme(color_scheme); return result(); },
  };
}
