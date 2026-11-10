import './style.css';
const app = document.querySelector('#app');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state;
let checkoutDraft;
let accountPromptDismissed = false;
async function api(path, data) {
  const response = await fetch(`/api/${path}`, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
function notify(text, error = false) {
  const element = document.querySelector('#feedback');
  element.textContent = text;
  element.setAttribute('role', error ? 'alert' : 'status');
  if (error) element.focus();
}
function input(label, name, value = '', type = 'text', extra = '') {
  return `<label>${label}<input name="${name}" type="${type}" value="${escape(value)}" ${extra} required></label>`;
}
// Held-out evaluation variants use neutral flag names so the page never names its friction.
const variant = n => state.defects[`variant-${n}`];
function link(href, label) { return `<a href="${href}">${label}</a>`; }
function money(cents) { return `$${(cents / 100).toFixed(2)}`; }
async function render() {
  state = await api('state');
  const flags = Object.keys(state.defects).filter(key => state.defects[key]);
  document.body.className = flags.join(' ');
  const total = state.cart.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const route = location.pathname;
  const menu = state.defects['hover-only-menu']
    ? '<div class="hover-menu"><span>Account</span><div class="menu-items"><a href="/profile">Profile</a></div></div>'
    : '<details><summary>Account</summary><a href="/profile">Profile</a></details>';
  const count = state.cart.reduce((n, i) => n + i.quantity, 0);
  const cartLink = variant(10) ? `<a href="/cart" class="icon-cart"><span aria-hidden="true">🛒</span>${count}</a>` : link('/cart', `${variant(5) ? 'Basket' : 'Cart'} (${count})`);
  app.innerHTML = `<a class="skip" href="#main">Skip to content</a><header><a href="/">Sample shop</a><nav aria-label="Main">${cartLink}${state.user ? menu : link('/login', 'Sign in')}</nav></header><main id="main"><div id="feedback" role="status" tabindex="-1"></div><div id="content"></div></main><footer>Synthetic QA store. No real payments.</footer>`;
  const content = document.querySelector('#content');
  if (route === '/') {
    content.innerHTML = `<section class="hero"><h1>Everyday essentials</h1><p>Choose an item. Check out as a guest or sign in to reuse a saved address.</p></section><div class="products">${state.products.map(p => `<article class="card"><h2>${escape(p.name)}</h2><p>${money(p.price)}</p><button data-add="${p.id}" ${state.defects['keyboard-barrier'] ? 'tabindex="-1"' : ''}>Add ${escape(p.name)} to cart</button></article>`).join('')}</div>`;
    for (const button of document.querySelectorAll('[data-add]')) button.onclick = async () => {
      await api('cart', { product_id: Number(button.dataset.add) });
      if (variant(15)) { navigate('/checkout'); return; }
      if (!variant(9)) await render();
      notify('Added to cart. Open Cart to review your order.');
    };
  } else if (route === '/login' || route === '/register') {
    const registration = route === '/register';
    content.innerHTML = `<h1>${registration ? 'Create an account' : 'Sign in'}</h1><form>${input('Email', 'email', '', 'email', 'autocomplete="username"')}${input('Password', 'password', '', 'password', `minlength="8" autocomplete="${registration ? 'new-password' : 'current-password'}"`)}<button>${registration ? 'Create account' : 'Sign in'}</button></form><p>${link(registration ? '/login' : '/register', registration ? 'Already have an account? Sign in' : 'Create an account')}</p>${link('/', 'Continue shopping as a guest')}`;
    document.querySelector('form').onsubmit = submit(async data => {
      const result = await api(registration ? 'register' : 'login', data);
      if (registration) notify(result.message); else navigate('/profile');
    });
  } else if (route === '/verify') {
    content.innerHTML = '<h1>Verify email</h1><a href="/login">Sign in</a>';
    try { notify((await api('verify', { token: new URLSearchParams(location.search).get('token') })).message); }
    catch (error) { notify(error.message, true); }
  } else if (route === '/profile') {
    if (!state.user) { navigate('/login'); return; }
    content.innerHTML = `<h1>Your profile</h1><p>Signed in as ${escape(state.user.email)}</p><form>${input('Delivery address', 'address', state.user.address, 'text', `autocomplete="street-address"${variant(14) ? ' maxlength="12"' : ''}`)}<button ${state.defects['disabled-save'] ? 'disabled' : ''}>Save address</button></form>${state.user.persona === 'admin' ? '<h2>Import contacts</h2><label>CSV file<input type="file" accept=".csv" id="import"></label>' : ''}`;
    document.querySelector('form').onsubmit = submit(async data => {
      notify((await api('profile', data)).message);
      if (variant(8)) document.querySelector('[name=address]').value = '';
    });
    const upload = document.querySelector('#import');
    if (upload) upload.onchange = async () => notify((await api('import', { csv: await upload.files[0].text() })).message);
  } else if (route === '/cart') {
    content.innerHTML = `<h1>${variant(5) ? 'Your bag' : 'Your cart'}</h1>${state.cart.length ? `<ul>${state.cart.map(p => `<li>${escape(p.name)} × ${p.quantity} — ${money(p.price * p.quantity)}</li>`).join('')}</ul><p>Total: ${money(total)}</p><a class="button" href="/checkout">${variant(5) ? 'Proceed to order form' : 'Checkout'}</a>` : '<p>Your cart is empty.</p>'}<p>${link('/', 'Continue shopping')}</p>`;
  } else if (route === '/checkout' && variant(11) && !accountPromptDismissed) {
    content.innerHTML = '<section class="account-prompt"><h1>Check out faster with an account</h1><p>Create an account to save your details for next time.</p><a class="button" href="/register">Create account</a><button type="button" id="not-now" class="quiet">Not now</button></section>';
    document.querySelector('#not-now').onclick = () => { accountPromptDismissed = true; render(); };
  } else if (route === '/checkout') {
    checkoutDraft ??= { email: state.user?.email || '', address: state.user?.address || '', billing: '' };
    const field = (label, name, value, type, extra) => variant(3) ? `<input name="${name}" type="${type}" value="${escape(value)}" placeholder="${label}" ${extra} required>` : input(label, name, value, type, extra);
    const intro = variant(4) ? 'Submit PO for tender. SKU qty locked on commit.' : variant(2) ? 'Review your details, then pay.' : `Review your details, then pay ${money(total)}.`;
    const sameBilling = variant(4) ? 'BILL_ADDR := SHIP_ADDR (override via EDIT).' : 'Billing address is the same as delivery. You can edit it before paying.';
    content.innerHTML = `<h1>${variant(5) ? 'Order form' : 'Checkout'}</h1><p>${intro} No account needed.</p><form>${field('Email', 'email', checkoutDraft.email, 'email', 'autocomplete="email"')}${field('Delivery address', 'address', checkoutDraft.address, 'text', 'autocomplete="shipping street-address"')}${state.defects['duplicate-address'] ? input('Billing address (enter the same address again)', 'billing', checkoutDraft.billing) : `<p>${sameBilling}</p><button type="button" id="edit-billing">Edit billing address</button><div id="billing"></div>`}${variant(2) ? '' : `<p>Total: ${money(total)}</p>`}<button class="pay">${state.defects['ambiguous-next'] ? 'Continue' : variant(2) ? 'Pay now' : `Pay ${money(total)}`}</button>${state.defects['missing-cancel'] ? '' : '<a href="/cart">Cancel and return to cart</a>'}</form>${state.defects['fixed-banner'] ? '<aside class="fixed-banner">Subscribe for offers</aside>' : ''}`;
    const form = document.querySelector('form');
    form.oninput = () => { checkoutDraft = Object.fromEntries(new FormData(form)); };
    const edit = document.querySelector('#edit-billing');
    if (edit) edit.onclick = () => { document.querySelector('#billing').innerHTML = input('Billing address', 'billing', checkoutDraft.billing); document.querySelector('[name=billing]').focus(); };
    let confirmed = !variant(6);
    form.onsubmit = submit(async data => {
      if (!confirmed) {
        // An extra, uninformative confirmation step before the real payment.
        form.hidden = true;
        form.insertAdjacentHTML('afterend', '<section id="confirm-step"><h2>Confirm</h2><p>Are you sure you want to continue?</p><button type="button" id="confirm-yes">Yes, continue</button></section>');
        document.querySelector('#confirm-yes').onclick = () => { confirmed = true; document.querySelector('#confirm-step').remove(); form.hidden = false; form.requestSubmit(); };
        return;
      }
      try {
        const result = await api('checkout', data);
        // A completed payment empties the server cart; reflect it immediately
        // in the persistent navigation, including the missing-feedback variant.
        document.querySelector('nav a[href="/cart"]').textContent = 'Cart (0)';
        if (result.confirmation) {
          content.innerHTML = `<h1 tabindex="-1">Order confirmed</h1><p>Order ${result.order} is complete. A receipt will be sent to ${escape(data.email)}.</p><a href="/">Continue shopping</a>`;
          document.querySelector('h1').focus();
        } else content.innerHTML = '<section aria-label="Order result"></section>';
        checkoutDraft = undefined;
      } catch (error) {
        if (state.defects['lost-input']) { checkoutDraft = { email: '', address: '', billing: '' }; await render(); }
        if (variant(7) && !document.querySelector('#abandon')) {
          form.querySelector('.pay').classList.add('demoted');
          form.querySelector('.pay').insertAdjacentHTML('beforebegin', '<button type="button" id="abandon" class="danger">Abandon order</button>');
          document.querySelector('#abandon').onclick = () => { checkoutDraft = undefined; navigate('/'); };
        }
        if (variant(12)) {
          // The decline is reported only below the footer, without focus or an announcement.
          document.querySelector('.late-error')?.remove();
          document.querySelector('footer').insertAdjacentHTML('afterend', `<p class="late-error">${escape(error.message)}</p>`);
          return;
        }
        if (variant(1)) throw new Error('Error 402: PAYMENT_DECLINED (code 51)');
        throw error;
      }
    });
  } else content.innerHTML = '<h1>Page not found</h1><a href="/">Return to shop</a>';
  if (state.defects['raw-primitive']) document.querySelector('button')?.classList.add('raw');
  if (state.defects['small-icon-buttons']) content.insertAdjacentHTML('beforeend', '<button class="icon" aria-label="Help">?</button>');
  if (state.defects['console-error']) console.error('QA fixture: failed to load order summary');
}
function submit(handler) {
  return async event => {
    event.preventDefault();
    const button = event.target.querySelector('button[type=submit],button:not([type])');
    if (button) button.disabled = true;
    try { await handler(Object.fromEntries(new FormData(event.target))); }
    catch (error) { notify(error.message, true); }
    finally { if (button) button.disabled = false; }
  };
}
function navigate(href) {
  history.pushState({}, '', href);
  render().catch(error => notify(error.message, true));
}
document.addEventListener('click', event => {
  const anchor = event.target.closest('a');
  if (anchor && anchor.origin === location.origin && !anchor.hash && !event.metaKey && !event.ctrlKey) { event.preventDefault(); navigate(anchor.href); }
});
window.addEventListener('popstate', () => render());
render().catch(error => { app.textContent = error.message; });
