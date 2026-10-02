import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'probe-race-'));
process.env.DSH_HOME = home;
console.log('home:', home, '| 路径长度检查:', Buffer.byteLength(join(home, 'peer-bus', 's', 'x'.repeat(16) + '.sock')));

const { SessionBus } = await import('../src/peer-bus.js');
const { Context } = await import('@deepseek-ai/cordis');

const config = (allow) => ({
  allow, maxMessageBytes: 16384, maxSendsPerWindow: 10, rateWindowMs: 60000,
  waitTimeoutMs: 60000, maxWaitMs: 600000, askBusyTimeoutMs: 30000,
  crossProcess: true, crossProcessTimeoutMs: 2000, crossProcessDeliverTimeoutMs: 60000,
});

const mkAgent = (id) => ({ id, status: 'idle', session: { id, header: { id, cwd: '/tmp/ws' } }, delivered: [],
  followup(m) { this.delivered.push(m); }, steer(m) { this.delivered.push(m); } });

const mkCtx = (agents) => {
  const ctx = new Context();
  const map = new Map(agents.map((a) => [a.id, a]));
  ctx.provide('agents', { list: () => [...map.values()], get: (id) => map.get(id) });
  ctx.provide('sessionPersistence', { list: async () => [] });
  return ctx;
};

let ok = 0, bad = 0;
const failures = [];
for (let i = 0; i < 15; i += 1) {
  const a = mkAgent('session-a');
  const b = mkAgent('session-b');
  const busA = new SessionBus(mkCtx([a]).isolate('peerBus'), config([{ from: 'session-a', to: 'session-b' }]));
  const busB = new SessionBus(mkCtx([b]).isolate('peerBus'), config([{ from: 'session-a', to: 'session-b' }]));
  await Promise.all([busA.xproc(), busB.xproc()]);
  const rows = await busA.roster();
  const remote = rows.find((r) => r.id === 'session-b');
  if (remote?.host === 'remote') ok += 1;
  else {
    bad += 1;
    const endpoint = await busA.xproc();
    const peers = endpoint === undefined ? 'no-endpoint' : (await endpoint.peers()).map((p) => p.endpointId);
    failures.push(`#${i} host=${remote?.host} live=${remote?.live} peers=${JSON.stringify(peers)} failed=${busA.xprocFailed}`);
  }
  await busA.dispose();
  await busB.dispose();
}
console.log(`发现成功 ${ok} / 失败 ${bad}`);
for (const f of failures.slice(0, 5)) console.log('  ', f);
await rm(home, { recursive: true, force: true });
process.exit(0);
