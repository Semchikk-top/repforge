import { createRelay } from './server.js';

const env = process.env;
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const relay = createRelay({
  origins: list(env.RELAY_ORIGINS),
  allowLocalhost: env.RELAY_ALLOW_LOCALHOST !== '0',
  trustProxy: env.RELAY_TRUST_PROXY === '1',
  ttlMs: env.RELAY_TTL_SEC ? Number(env.RELAY_TTL_SEC) * 1000 : undefined,
  log: (line) => console.log(new Date().toISOString(), line)
});

const port = Number(env.PORT ?? 8787);
const host = env.HOST ?? '127.0.0.1';
relay.listen(port, host).then((p) => console.log(`Релей «Рядом» слушает ${host}:${p}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => relay.close().then(() => process.exit(0)));
