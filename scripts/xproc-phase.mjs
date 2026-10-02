/**
 * One process of the cross-process e2e: the **host** that holds a session live.
 *
 * It boots DSH with the transport enabled, creates a session, announces its id on
 * stdout, and then stays alive doing nothing. Staying alive *is* the job — the
 * point of the test is that a second process can reach a session this one holds,
 * and a session is only held while its process lives.
 *
 * It is spawned by `scripts/e2e-xproc.mjs` and killed by it.
 *
 * It also has a `contend` mode: wait for an agreed instant, then try to deliver to a
 * session that is stored but held by nobody. Two processes doing that at the same
 * moment is the only way to find out what the log lock actually does under
 * contention — which error shape it raises, and whether the loser is told something
 * useful rather than that the resume simply failed.
 *
 * Usage: node scripts/xproc-phase.mjs host <runId>
 *        node scripts/xproc-phase.mjs contend <runId> <targetId> <raceAtEpochMs>
 */
import './dsh-home.mjs';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';

const [phase, runId, contendTarget, raceAtRaw] = process.argv.slice(2);
if (phase !== 'host' && phase !== 'contend') {
  console.error('usage: node scripts/xproc-phase.mjs host|contend <runId> [targetId] [raceAtEpochMs]');
  process.exit(2);
}
if (runId === undefined || (phase === 'contend' && (contendTarget === undefined || raceAtRaw === undefined))) {
  console.error('usage: node scripts/xproc-phase.mjs host|contend <runId> [targetId] [raceAtEpochMs]');
  process.exit(2);
}

const environment = createLaunchEnvironmentSnapshot([
  {
    source: 'process',
    values: Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
    ),
  },
]);

const { ctx, shutdown } = await runProfile({
  environment,
  profile: process.env.BUS_CHECK_PROFILE ?? 'headless',
  patchFiles: [new URL('../xproc.e2e.patch.yml', import.meta.url).pathname],
  args: [],
});

const bus = ctx.get('peerBus');
const agents = ctx.get('agents');
if (bus === undefined || agents === undefined) {
  console.error('HOST-FAILED missing services');
  await shutdown?.shutdown?.(1);
  process.exit(1);
}

// Started by the plugin's constructor, but awaited so the registry entry is
// durable before the id is announced: otherwise the guest could look for this
// session in the window before this process is discoverable.
await bus.xproc();

const hostId = phase === 'host' ? `session-xproc-host-${runId}` : `session-xproc-contender-${runId}`;
await agents.create({
  sessionId: hostId,
  meta: { cwd: process.cwd() },
});

console.log(`HOST-READY ${hostId}`);
console.log(`HOST-ENDPOINT ${(await bus.xproc())?.endpointId ?? 'none'}`);

if (phase === 'contend') {
  const raceAt = Number(raceAtRaw);
  const wait = Number.isFinite(raceAt) ? raceAt - Date.now() : 0;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  // A live agent of this process's own is the sender. Passing a bare id would be
  // refused as `unauthorized` before any lock was ever touched, and the race would
  // silently not happen.
  const contenderAgent = (
    await agents.create({ sessionId: `session-xproc-contender-sender-${runId}`, meta: { cwd: process.cwd() } })
  ).agent;
  // A session this process does not hold and nobody else does: the local path is
  // the only route, so both contenders land on the same log lock together.
  const outcome = await bus
    .send(contenderAgent, { target: contendTarget, text: 'contended' }, {})
    .then((result) => ({
      ok: true,
      targetState: result.targetState,
      // Does this process actually hold a live agent for it now?
      holds: agents.get(contendTarget) !== undefined,
      status: agents.get(contendTarget)?.status,
    }))
    .catch((error) => ({ ok: false, code: error?.code, message: error?.message }));
  console.log(`CONTEND ${JSON.stringify(outcome)}`);
  // Linger after answering. The loser of the claim race is supposed to *forward* its
  // message here, and exiting immediately would turn that into an EPIPE — the test
  // would then be measuring shutdown timing rather than the handoff.
  await new Promise((resolve) => setTimeout(resolve, 8000));
  await shutdown?.shutdown?.(0);
  process.exit(0);
}

/** Shut down cleanly when the parent asks, so the registry entry is withdrawn. */
process.on('SIGTERM', () => {
  void (async () => {
    await shutdown?.shutdown?.(0);
    process.exit(0);
  })();
});

// Stay alive holding the session. An unresolved promise keeps the process up
// without spinning, and every real event (a delivered message, a socket frame)
// is handled by the loop as usual.
await new Promise(() => {});
