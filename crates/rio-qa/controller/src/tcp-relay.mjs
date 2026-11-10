import { createServer, connect } from 'node:net';

export async function tcpRelay({ host = '127.0.0.1', port, targetHost, targetPort }) {
  const sockets = new Set(); let closing;
  const server = createServer(socket => {
    const upstream = connect(targetPort, targetHost);
    for (const peer of [socket, upstream]) { sockets.add(peer); peer.on('close', () => sockets.delete(peer)); }
    socket.pipe(upstream).pipe(socket);
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); });
  return { close() { return closing ||= (async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); })(); } };
}
