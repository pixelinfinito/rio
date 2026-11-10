import { test, expect } from '@playwright/test';
async function login(page, persona = 'shopper') {
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(`${persona}@example.test`);
  await page.getByLabel('Password').fill(`synthetic-${persona}-123`);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
}
async function cart(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Add Canvas bag to cart' }).click();
  await expect(page.getByRole('status')).toContainText('Added to cart');
  await page.getByRole('link', { name: 'Cart (1)' }).click();
  await page.getByRole('link', { name: 'Checkout', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
}
test.beforeEach(async ({ request }) => {
  await request.post('http://127.0.0.1:4180/test/behavior', { data: 'approve' });
});
test('login and save profile', async ({ page }) => {
  await login(page);
  await page.getByLabel('Delivery address').fill('10 Example Lane, Test City');
  await page.getByRole('button', { name: 'Save address' }).click();
  await expect(page.getByRole('status')).toHaveText('Address saved.');
});
test('cart state reaches checkout; decline preserves input and retry succeeds', async ({ page, request }) => {
  await login(page);
  await cart(page);
  await expect(page.getByLabel('Delivery address', { exact: true })).toHaveValue('10 Example Lane, Test City');
  await page.getByLabel('Delivery address', { exact: true }).fill('20 Recovery Road, Test City');
  await request.post('http://127.0.0.1:4180/test/behavior', { data: 'decline' });
  await page.getByRole('button', { name: 'Pay $24.00' }).click();
  await expect(page.getByRole('alert')).toContainText('Payment declined');
  await expect(page.getByLabel('Delivery address', { exact: true })).toHaveValue('20 Recovery Road, Test City');
  await expect(page.getByRole('link', { name: 'Cancel and return to cart' })).toBeVisible();
  await request.post('http://127.0.0.1:4180/test/behavior', { data: 'approve' });
  await page.getByRole('button', { name: 'Pay $24.00' }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Cart (0)', exact: true })).toBeVisible();
  await page.goto('/cart');
  await expect(page.getByText('Your cart is empty.')).toBeVisible();
});
test('guest checkout works without account creation', async ({ page }) => {
  await cart(page);
  await page.getByLabel('Email', { exact: true }).fill('guest@example.test');
  await page.getByLabel('Delivery address', { exact: true }).fill('30 Guest Street, Test City');
  await page.getByRole('button', { name: 'Pay $24.00' }).click();
  await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
});
test('registration follows captured SMTP verification link', async ({ page, request }, testInfo) => {
  const email = `new-${testInfo.project.name}@example.test`;
  await page.goto('/register');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('synthetic-registration-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('status')).toContainText('Check your email');
  const messages = await (await request.get('http://127.0.0.1:4180/test/mail')).json();
  const message = messages.findLast(message => message.includes(email));
  const link = message.match(/http:\/\/[^\s]+/)[0];
  await page.goto(link);
  await expect(page.getByRole('status')).toContainText('Email verified');
  await page.getByRole('link', { name: 'Sign in', exact: true }).last().click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('synthetic-registration-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible();
});
test('admin uploads generated CSV', async ({ page }) => {
  await login(page, 'admin');
  await page.getByLabel('CSV file').setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from('name,email\nSynthetic One,one@example.test\nSynthetic Two,two@example.test\n') });
  await expect(page.getByRole('status')).toHaveText('Imported 2 rows.');
});
