// Fixture test infrastructure only: not served by the application or built into Rio.
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { readFileSync } from 'node:fs';
export async function services(paymentPort = 4180, smtpPort = 2525) {
  let behavior = 'approve';
  const messages = [];
  const payments = httpServer(async (req, res) => {
    if (req.url === '/test/behavior' && req.method === 'POST') {
      let text = ''; for await (const chunk of req) text += chunk;
      if (!['approve', 'decline'].includes(text)) { res.writeHead(400); res.end(); return; }
      behavior = text; res.end('ok'); return;
    }
    if (req.url === '/test/mail') { res.setHeader('content-type','application/json'); res.end(JSON.stringify(messages)); return; }
    if (req.url !== '/v1/charges' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const recording = JSON.parse(readFileSync(new URL(`../.rio/qa/fixtures/recordings/payments/${behavior}.json`, import.meta.url)));
    res.writeHead(recording.response.status, recording.response.headers);
    res.end(JSON.stringify(recording.response.body));
  });
  const mail = tcpServer(socket => {
    socket.write('220 qa.test SMTP\r\n');
    let pending = '', message = '', reading = false;
    socket.on('data', chunk => {
      pending += chunk;
      while (pending.includes('\r\n')) {
        const index = pending.indexOf('\r\n');
        const line = pending.slice(0, index); pending = pending.slice(index + 2);
        if (reading) {
          if (line === '.') { messages.push(message); message = ''; reading = false; socket.write('250 accepted\r\n'); }
          else message += line + '\n';
        } else if (line === 'DATA') { reading = true; socket.write('354 send message\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await Promise.all([new Promise(resolve => payments.listen(paymentPort, '127.0.0.1', resolve)), new Promise(resolve => mail.listen(smtpPort, '127.0.0.1', resolve))]);
  return { close: () => { payments.close(); mail.close(); } };
}
