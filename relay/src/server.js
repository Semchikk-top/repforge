import http from 'node:http';
import { WebSocketServer } from 'ws';
import { MAX_SDP, RoomStore } from './rooms.js';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function originAllowed(origin, { origins = [], allowLocalhost = true } = {}) {
  if (!origin) return false;
  if (origins.includes('*') || origins.includes(origin)) return true;
  return allowLocalhost && LOCAL_ORIGIN.test(origin);
}

/**
 * @param {object} o
 * @param {string[]} [o.origins] разрешённые Origin (адреса, откуда раздаётся приложение)
 * @param {boolean} [o.allowLocalhost] разрешить localhost для разработки
 * @param {boolean} [o.trustProxy] брать адрес клиента из CF-Connecting-IP / X-Forwarded-For (за Cloudflare Tunnel и т.п.)
 * @param {(line:string)=>void} [o.log] журнал; SDP и коды комнат в него не попадают
 */
export function createRelay(o = {}) {
  const store = new RoomStore(o);
  const log = o.log ?? (() => {});
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_SDP + 4096 });

  server.on('upgrade', (req, socket, head) => {
    if (!originAllowed(req.headers.origin, o)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      log('отклонён: чужой Origin');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const clientIp = (req) => {
    if (o.trustProxy) {
      const h = req.headers['cf-connecting-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0];
      if (h && String(h).trim()) return String(h).trim();
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  wss.on('connection', (ws, req) => {
    const conn = {
      ip: clientIp(req), room: null, role: null,
      send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
      close() { try { ws.close(1000); } catch { /* уже закрыт */ } }
    };
    // кто за 10 секунд не создал и не вошёл в комнату — не нужен
    const idle = setTimeout(() => { if (!conn.room && !conn.done) ws.close(1008); }, 10_000);
    idle.unref?.();
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return conn.send({ t: 'error', code: 'bad-message', message: 'Нужен текст' });
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return conn.send({ t: 'error', code: 'bad-message', message: 'Некорректный JSON' }); }
      store.handle(conn, msg);
    });
    ws.on('close', () => { clearTimeout(idle); store.disconnect(conn); });
    ws.on('error', () => { /* обрыв: обработает close */ });
  });

  const keepalive = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* закрывается */ }
    }
    store.limiter.sweep();
  }, 25_000);
  keepalive.unref?.();

  return {
    store, server,
    listen: (port = 8787, host = '127.0.0.1') => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      clearInterval(keepalive);
      store.shutdown();
      for (const ws of wss.clients) ws.terminate();
      server.close(() => resolve());
    })
  };
}
