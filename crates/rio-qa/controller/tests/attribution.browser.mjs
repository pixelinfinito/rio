import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBrowser } from '../src/browser.mjs';
import { elementAttribution, stackHints, observationTargets } from '../src/attribution.mjs';
import { probeCandidates, observationCandidates } from '../src/findings.mjs';

test('development annotations and stack hints stay data and normalize into host finding candidates', async () => {
  const browser = await openBrowser({ viewport: { width: 390, height: 844, mobile: true, touch: true } });
  try {
    await browser.page.setContent('<button id="react" class="primary">Save</button><button id="vue">Pay</button><button id="svelte">Undo</button><button id="vite" data-v-inspector="src/Card.vue:12:4">Continue</button>');
    await browser.page.evaluate(() => {
      document.querySelector('#react').__reactFiber$test = { _debugSource: { fileName: '/app/src/React.tsx', lineNumber: 21 } };
      document.querySelector('#vue').__vueParentComponent = { type: { __file: '/app/src/Vue.vue' } };
      document.querySelector('#svelte').__svelte_meta = { loc: { file: 'src/Svelte.svelte', line: 9 } };
    });
    const hints = await browser.page.evaluate(elementAttribution, ['#react', '#vue', '#svelte', '#vite']);
    assert.deepEqual(hints.map(hint => hint.annotations[0]), [
      { path: '/app/src/React.tsx', line: 21 }, { path: '/app/src/Vue.vue', line: 1 }, { path: 'src/Svelte.svelte', line: 10 }, { path: 'src/Card.vue', line: 12 },
    ]);
    assert.deepEqual(hints[0].text, ['Save']); assert.deepEqual(hints[0].classes, ['primary']);
    const stack = stackHints([{ kind: 'error', stack: 'Error\n    at save (http://app/src/Billing.tsx:40:3)\n    at http://app/src/Card.tsx:2:1' }]);
    assert.deepEqual(stack, [{ path: 'http://app/src/Billing.tsx', line: 40 }, { path: 'http://app/src/Card.tsx', line: 2 }]);
    const cell = { viewport: 'mobile', color_scheme: 'light' }, journeys = { checkout: { covers: { routes: ['/orders/:id'] } } };
    const candidates = probeCandidates([{ rule_id: 'mobile/tap-target', kind: 'accessibility', severity: 'warning', occurrences: [{ observations: [{ journey: 'checkout', step: 2, page: 'http://app/orders/123?token=secret', cell, role_signature: { tag: 'button', role: 'button', name: 'Save' }, element_path: '#react', measurements: { width: 28 }, evidence: { screenshot: 'screenshot-id', dom: 'dom-id' }, attribution: hints[0] }] }] }], journeys);
    assert.equal(candidates[0].route_pattern, '/orders/:id'); assert.equal(candidates[0].trigger.kind, 'probe'); assert.deepEqual(candidates[0].evidence, ['screenshot-id', 'dom-id']);
    const hypotheses = observationCandidates([{ rule_id: 'ui/no-feedback', journey: 'checkout', step: 2, cell, kind: 'ux', route: 'http://app/orders/123', expected: { text: 'Confirmed' }, observed: { text: '' }, suggested_fix: 'Confirm the order', evidence: ['screenshot-id'] }], journeys, [{ id: 'ui/no-feedback', severity: 'warning' }]);
    assert.equal(hypotheses[0].trigger.kind, 'observation'); assert.equal(hypotheses[0].route_pattern, '/orders/:id');
  } finally { await browser.close(); }
});

test('observation targets ignore selector spelling and layout but distinguish controls', async () => {
  const browser = await openBrowser({ viewport: { width: 390, height: 844, mobile: true, touch: true } });
  try {
    await browser.page.setContent('<main><section aria-label="Order result"></section><button>Retry</button><button>Retry</button></main>');
    const mobile = await browser.page.evaluate(observationTargets, ['main', "[aria-label='Order result']"]);
    await browser.page.setViewportSize({ width: 1280, height: 900 });
    const desktop = await browser.page.evaluate(observationTargets, ['section[aria-label="Order result"]']);
    assert.deepEqual(mobile, desktop);
    assert.equal(mobile.length, 1);
    assert.equal(mobile[0].name, 'Order result');
    const first = await browser.page.evaluate(observationTargets, ['button:first-of-type']);
    const second = await browser.page.evaluate(observationTargets, ['button:last-of-type']);
    assert.notDeepEqual(first, second);
    assert.deepEqual(await browser.page.evaluate(observationTargets, ['#missing']), []);
    await browser.page.evaluate(() => {
      for (const id of ['delivery', 'billing']) {
        const host = document.createElement('div'); host.id = id; document.body.append(host);
        host.attachShadow({ mode: 'open' }).innerHTML = '<button>Retry</button>';
      }
    });
    assert.notDeepEqual(await browser.page.evaluate(observationTargets, ['#delivery >>> button']),
      await browser.page.evaluate(observationTargets, ['#billing >>> button']));
  } finally { await browser.close(); }
});
