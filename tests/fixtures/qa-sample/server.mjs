import { createServer } from 'node:http';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { database, passwordHash, checkPassword } from './scripts/db.mjs';

const db = database();
const port = Number(process.env.PORT || 4173);
const root = resolve('dist');
const defects = JSON.parse(readFileSync('defects.json', 'utf8'));
for (const name of (process.env.QA_DEFECTS || '').split(',').filter(Boolean)) {
  if (!(name in defects)) throw new Error(`Unknown defect ${name}`);
  defects[name] = true;
}
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1024 * 1024) throw new Error('Request too large');
  }
  return text ? JSON.parse(text) : {};
}
function session(req, res) {
  let token = /(?:^|;\s*)session=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  if (!token || !db.prepare('SELECT 1 FROM sessions WHERE token=?').get(token)) {
    token = randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions(token) VALUES (?)').run(token);
    res.setHeader('set-cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/`);
  }
  const user = db.prepare('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=?').get(token);
  return { token, user };
}
async function mail(email, link) {
  // Real SMTP delivery to the fixture capture service, never a production host.
  const host = process.env.SMTP_HOST || '127.0.0.1';
  const smtpPort = Number(process.env.SMTP_PORT || 2525);
  await new Promise((resolve, reject) => {
    const socket = connect(smtpPort, host);
    const commands = ['EHLO qa.sample', 'MAIL FROM:<shop@example.test>', `RCPT TO:<${email}>`, 'DATA', `Subject: Verify your account\r\nTo: ${email}\r\n\r\n${link}\r\n.`, 'QUIT'];
    let pending = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Mail capture timeout')));
    socket.on('error', reject);
    socket.on('data', chunk => {
      pending += chunk;
      while (pending.includes('\r\n')) {
        const index = pending.indexOf('\r\n');
        const line = pending.slice(0, index); pending = pending.slice(index + 2);
        if (!/^\d{3} /.test(line)) continue;
        if (Number(line.slice(0, 3)) >= 400) { socket.destroy(new Error('Mail capture rejected delivery')); return; }
        const command = commands.shift();
        if (command) socket.write(command + '\r\n');
        else { socket.end(); resolve(); }
      }
    });
  });
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://app');
    if (!url.pathname.startsWith('/api/')) {
      let path = resolve(root, '.' + decodeURIComponent(url.pathname));
      if (path !== root && !path.startsWith(root + sep)) return send(res, 404, { error: 'Not found' });
      if (path === root || !statSync(path, { throwIfNoEntry: false })?.isFile()) path = resolve(root, 'index.html');
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'content-type': mime[extname(path)] || 'application/octet-stream' });
      return res.end(readFileSync(path));
    }
    if (url.pathname === '/api/health') return send(res, 200, { ok: true });
    const { token, user } = session(req, res);
    const data = req.method === 'POST' ? await body(req) : {};
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /api/state': return send(res, 200, {
        defects, user: user ? { email: user.email, address: user.address, persona: user.persona } : null,
        products: db.prepare('SELECT * FROM products').all(),
        cart: db.prepare('SELECT p.*,c.quantity FROM cart c JOIN products p ON p.id=c.product_id WHERE c.session=?').all(token)
      });
      case 'POST /api/login': {
        const account = db.prepare('SELECT * FROM users WHERE email=? AND verified=1').get(data.email);
        if (!account || !checkPassword(String(data.password || ''), account.password_hash)) return send(res, 401, { error: 'Email or password is incorrect. Try again.' });
        db.prepare('UPDATE sessions SET user_id=? WHERE token=?').run(account.id, token);
        return send(res, 200, { ok: true });
      }
      case 'POST /api/register': {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email || '') || String(data.password || '').length < 8) return send(res, 400, { error: 'Use an email address and a password of at least 8 characters.' });
        if (db.prepare('SELECT id FROM users WHERE email=?').get(data.email)) return send(res, 409, { error: 'That email already has an account. Sign in instead.' });
        const result = db.prepare('INSERT INTO users(email,password_hash) VALUES (?,?)').run(data.email, passwordHash(data.password));
        const verification = randomBytes(24).toString('hex');
        db.prepare('INSERT INTO verifications VALUES (?,?)').run(verification, result.lastInsertRowid);
        await mail(data.email, `${process.env.APP_URL || `http://127.0.0.1:${port}`}/verify?token=${verification}`);
        return send(res, 201, { message: 'Check your email for a verification link.' });
      }
      case 'POST /api/verify': {
        const verification = db.prepare('SELECT user_id FROM verifications WHERE token=?').get(data.token);
        if (!verification) return send(res, 400, { error: 'This link is invalid or has expired. Register again.' });
        db.prepare('UPDATE users SET verified=1 WHERE id=?').run(verification.user_id);
        db.prepare('DELETE FROM verifications WHERE token=?').run(data.token);
        return send(res, 200, { message: 'Email verified. You can sign in.' });
      }
      case 'POST /api/cart': {
        if (!db.prepare('SELECT id FROM products WHERE id=?').get(data.product_id)) return send(res, 400, { error: 'Product unavailable.' });
        db.prepare('INSERT INTO cart VALUES (?,?,1) ON CONFLICT(session,product_id) DO UPDATE SET quantity=quantity+1').run(token, data.product_id);
        return send(res, 200, { message: 'Added to cart.' });
      }
      case 'POST /api/profile': {
        if (!user) return send(res, 401, { error: 'Sign in to save an address.' });
        if (!String(data.address || '').trim()) return send(res, 400, { error: 'Enter an address.' });
        db.prepare('UPDATE users SET address=? WHERE id=?').run(data.address, user.id);
        return send(res, 200, { message: 'Address saved.' });
      }
      case 'POST /api/import': {
        if (user?.persona !== 'admin') return send(res, 403, { error: 'Admin access required.' });
        const rows = String(data.csv || '').trim().split('\n').slice(1);
        return send(res, 200, { message: `Imported ${rows.length} rows.` });
      }
      case 'POST /api/checkout': {
        const total = db.prepare('SELECT SUM(p.price*c.quantity) AS total FROM cart c JOIN products p ON p.id=c.product_id WHERE session=?').get(token).total;
        if (!total) return send(res, 400, { error: 'Your cart is empty. Add an item first.' });
        if (!String(data.address || '').trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email || '')) return send(res, 400, { error: 'Enter your email and delivery address.' });
        const payment = await fetch(`${process.env.PAYMENTS_API_BASE || 'http://payments.example.test'}/v1/charges`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: total, currency: 'usd' }), signal: AbortSignal.timeout(5000)
        });
        if (!payment.ok) return send(res, 402, { error: 'Payment declined. Your cart and address are saved. Try again or cancel.' });
        const order = db.prepare('INSERT INTO orders(user_id,email,address,total) VALUES (?,?,?,?)').run(user?.id || null, data.email, data.address, total);
        db.prepare('DELETE FROM cart WHERE session=?').run(token);
        return send(res, 201, { order: Number(order.lastInsertRowid), confirmation: !defects['missing-confirmation'] });
      }
      default: return send(res, 404, { error: 'Not found' });
    }
  } catch {
    send(res, 500, { error: 'Something went wrong. Your cart is saved. Try again.' });
  }
});
server.listen(port, process.env.HOST || '0.0.0.0');
process.on('SIGTERM', () => server.close(() => { db.close(); process.exit(0); }));
