import { FixtureClient } from './fixture-client.mjs';
import { randomUUID } from 'node:crypto';

const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const extension = { image: 'png', pdf: 'pdf', csv: 'csv', json: 'json', text: 'txt', binary: 'bin' };

/** Named tools resolve credentials and files outside harness arguments. The
 * controller has no source tree, and browser paths never enter tool results. */
export class AppTools extends FixtureClient {
  constructor(options) {
    super(options);
    this.personaDefinitions = new Map((options.personas || []).map(persona => [persona.name, persona]));
    this.credentialEnv = options.credentialEnv || {};
    this.browser = options.browser; this.appOrigins = new Set(options.appOrigins || options.allowedOrigins);
    this.browserFiles = options.browserFiles; this.maxFileBytes = options.maxFileBytes || 2 * 1024 ** 3;
    this.files = new Map((options.fixtures?.files || []).map(file => [file.name, file])); this.uploads = new Map();
    this.handlers.login = args => this.login(args.persona);
    this.handlers.upload_fixture = args => this.upload(args.name);
    this.handlers.read_dependencies = async () => reply({ failures: await this.dependencyFailures(this.browser) });
    this.chooser = undefined;
    this.watch = page => page.on('filechooser', chooser => { this.chooser = chooser; });
    for (const page of this.browser.context.pages()) this.watch(page);
    this.browser.context.on('page', this.watch);
  }
  async login(persona) {
    if (!this.personas.has(persona)) throw new Error('Undeclared persona');
    const declaration = this.personaDefinitions.get(persona);
    const credentials = !declaration.username_env && !declaration.password_env ? { anonymous: true } : {
      username: this.credentialEnv[declaration.username_env], password: this.credentialEnv[declaration.password_env],
    };
    if (credentials.anonymous === true) return reply({ persona, anonymous: true });
    for (const [field, name] of [['username', declaration.username_env], ['password', declaration.password_env]]) {
      if (name && (typeof credentials[field] !== 'string' || !credentials[field])) throw new Error('Missing persona credentials');
    }
    this.sanitizer.add([credentials.username, credentials.password].filter(Boolean));
    const page = this.browser.page;
    const checkOrigin = () => { if (!this.appOrigins.has(new URL(page.url()).origin)) throw new Error('Login is outside the application'); };
    const usernameSelector = 'input[type=email]:visible, input[type=text]:visible, input:not([type]):visible';
    checkOrigin();
    if (!await page.locator('input[type=password]:visible').count() && !await page.locator(usernameSelector).count()) {
      const link = page.getByRole('link', { name: /^(sign in|log in|login)$/i });
      if (await link.count() !== 1) throw new Error('Open the login form before logging in');
      await link.click();
    }
    // Conventional single-form and username-then-password flows. A unique form
    // is required at every stage; no secret is returned for the agent to type.
    for (let stage = 0; stage < 2; stage++) {
      checkOrigin();
      const password = page.locator('input[type=password]:visible');
      const username = page.locator(usernameSelector);
      const anchor = await password.count() ? password : username;
      if (await anchor.count() !== 1) throw new Error('Login form is ambiguous');
      const form = anchor.locator('xpath=ancestor::form[1]');
      if (await form.count() !== 1) throw new Error('Login form is unavailable');
      const action = await form.getAttribute('action');
      if (action && !this.appOrigins.has(new URL(action, page.url()).origin)) throw new Error('Login submission is outside the application');
      const userInput = form.locator(usernameSelector), passwordInput = form.locator('input[type=password]:visible');
      const submit = form.locator('button[type=submit]:visible, input[type=submit]:visible, button:not([type]):visible');
      if (await submit.count() !== 1) throw new Error('Login controls are ambiguous');
      let filled = false, passwordFilled = false;
      for (const [control, value, isPassword] of [[userInput, credentials.username, false], [passwordInput, credentials.password, true]]) {
        if (value === undefined || !await control.count()) continue;
        if (await control.count() !== 1) throw new Error('Login controls are ambiguous');
        // Mask usernames as well as passwords before typing, including video.
        await control.evaluate(element => element.setAttribute('data-rio-mask', ''));
        await control.fill(value); filled = true; passwordFilled ||= isPassword;
      }
      if (!filled) throw new Error('Required login control is unavailable');
      await submit.click();
      if (!credentials.password || passwordFilled) return reply({ persona, submitted: true });
      await page.locator('input[type=password]:visible').waitFor({ timeout: 10000 });
    }
    throw new Error('Login did not reach the password form');
  }

  async upload(name) {
    const file = this.files.get(name); if (!file) throw new Error('Undeclared fixture file');
    // The clicked file chooser has precedence, otherwise a unique file input
    // is required. The model cannot supply a filesystem path or arbitrary code.
    const chooser = this.chooser; this.chooser = undefined;
    const input = this.browser.page.locator('input[type=file]');
    if (!chooser && await input.count() !== 1) throw new Error('Select an unambiguous file input first');
    let path = this.uploads.get(name);
    if (!path) {
      if (!this.browserFiles) throw new Error('Browser fixture staging unavailable');
      const signal = this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
      const response = await this.fetch(new URL(`/fixtures/files/${name}`, this.endpoint), { redirect: 'error', signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Fixture download failed'); }
      const size = Number(response.headers.get('content-length'));
      if (!Number.isSafeInteger(size) || size < 0 || size > (file.generate ? this.maxFileBytes : 1024 ** 2)) { await response.body?.cancel(); throw new Error('Fixture exceeds size limit'); }
      const filename = file.generate ? `${name}.${extension[file.generate.kind]}` : file.path.split('/').at(-1);
      const uploaded = await this.fetch(new URL(`/fixtures/${name}`, this.browserFiles), { method: 'PUT', redirect: 'error', signal,
        headers: { 'content-length': String(size), 'rio-fixture-filename': encodeURIComponent(filename) }, body: response.body, duplex: 'half' });
      if (!uploaded.ok) { await uploaded.body?.cancel(); throw new Error('Fixture staging failed'); }
      const result = await uploaded.json();
      if (result.name !== name || result.bytes !== size || typeof result.path !== 'string' || !/^\/tmp\/rio-browser-fixtures-[A-Za-z0-9]+\/[a-f0-9-]{36}\//.test(result.path) || result.path.split('/').at(-1) !== filename || result.path.split('/').length !== 5) throw new Error('Invalid fixture staging receipt');
      path = result.path; this.uploads.set(name, path);
    }
    // CDP addresses the staged path in the browser container. Playwright's
    // ordinary path API would stat a path in the controller filesystem first.
    const element = chooser ? chooser.element() : await input.elementHandle();
    const frame = await element.ownerFrame(), attribute = 'data-rio-upload-' + randomUUID();
    const cdp = await this.browser.context.newCDPSession(frame || this.browser.page);
    try {
      await element.evaluate((element, attribute) => element.setAttribute(attribute, ''), attribute);
      const { root } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[${attribute}]` });
      if (!nodeId) throw new Error('Upload input is no longer available');
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [path] });
    } finally {
      await element.evaluate((element, attribute) => element.removeAttribute(attribute), attribute).catch(() => {});
      await cdp.detach(); await element.dispose();
    }
    return reply({ name, attached: true });
  }
  async close() {
    this.browser.context.off('page', this.watch);
    if (this.browserFiles) {
      const response = await this.fetch(new URL('/fixtures', this.browserFiles), { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Browser fixture cleanup failed');
      await response.body?.cancel();
    }
    this.uploads.clear(); this.reset();
  }
}
