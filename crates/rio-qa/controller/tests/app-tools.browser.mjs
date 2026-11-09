import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { openBrowser } from '../src/browser.mjs';
import { AppTools } from '../src/app-tools.mjs';
import { Sanitizer } from '../src/sanitize.mjs';

for (const kind of ['username-only', 'password-only', 'two-stage']) {
  test(`named login handles ${kind} while masking every supplied credential`, async t => {
    const received = [];
    const form = password => `<form method="post"><label>${password ? 'Password<input type="password" name="password">' : 'Email<input type="email" name="username">'}</label><button>Continue</button></form>`;
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      if (request.method === 'POST') received.push(new URLSearchParams(body));
      response.setHeader('content-type', 'text/html');
      response.end(request.method === 'POST' ? kind === 'two-stage' && received.length === 1 ? form(true) : '<h1>Signed in</h1>' : form(kind === 'password-only'));
    }).listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await openBrowser({ viewport: { width: 390, height: 844, mobile: true, touch: true }, allowedOrigins: [origin] });
    const persona = { name: 'shopper', ...(kind !== 'password-only' ? { username_env: 'QA_USER' } : {}), ...(kind !== 'username-only' ? { password_env: 'QA_PASSWORD' } : {}) };
    const sanitizer = new Sanitizer();
    const tools = new AppTools({ endpoint: origin, browser, appOrigins: [origin], allowedOrigins: [origin], personas: [persona],
      sanitizer, credentialEnv: { QA_USER: 'synthetic-persona@example.test', QA_PASSWORD: 'synthetic-password' } });
    t.after(async () => { await tools.close(); await browser.close(); await new Promise(resolve => server.close(resolve)); });
    await browser.page.goto(origin);
    await browser.page.evaluate(() => {
      document.addEventListener('submit', event => {
        for (const input of event.target.querySelectorAll('input')) if (input.value && !input.hasAttribute('data-rio-mask')) event.preventDefault();
      });
    });
    const result = await tools.login('shopper');
    await browser.page.getByRole('heading', { name: 'Signed in' }).waitFor();
    assert.equal(received.length, kind === 'two-stage' ? 2 : 1);
    if (kind !== 'password-only') assert.equal(received[0].get('username'), 'synthetic-persona@example.test');
    if (kind !== 'username-only') assert.equal(received.at(-1).get('password'), 'synthetic-password');
    assert.deepEqual(JSON.parse(result.content[0].text), { persona: 'shopper', submitted: true });
    assert.ok(!JSON.stringify(result).includes('synthetic-'));
  });
}
