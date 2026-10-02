/**
 * The host half of the real-model cross-process check.
 *
 * Boots the same real-model overlay the orchestrator wrote, creates a session on the
 * real route, announces it, and stays alive. The interesting work happens when the
 * other process sends it something: a **real model turn** runs here, in this process,
 * on a message that arrived over a socket from a different process.
 *
 * Usage: node scripts/real-model-xproc-phase.mjs host <runId>
 */
import './dsh-home.mjs';
import { join } from 'node:path';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';

const [phase, runId] = process.argv.slice(2);
if (phase !== 'host' || runId === undefined) {
  console.error('usage: node scripts/real-model-xproc-phase.mjs host <runId>');
  process.exit(2);
}

const repo = join(import.meta.dirname, '..');
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
  profile: 'web',
  patchFiles: [
    join(repo, 'web-noserver.patch.yml'),
    join(process.env.DSH_HOME, 'real-model-xproc.patch.yml'),
  ],
  args: ['--no-open'],
});

const bus = ctx.get('peerBus');
const agents = ctx.get('agents');
const presets = ctx.get('agentPresets');
if (bus === undefined || agents === undefined) {
  console.error('HOST-FAILED missing services');
  await shutdown?.shutdown?.(1);
  process.exit(1);
}

// Awaited so the registry entry is durable before the id is announced, or the guest
// could look for this session in the window before this process is discoverable.
await bus.xproc();

const presetId = presets === undefined ? undefined : (await presets.resolve()).id;
const hostId = `session-real-xproc-host-${runId}`;
await agents.create({
  sessionId: hostId,
  // The workspace the orchestrator resolved, not this process's `cwd`: they can
  // differ by a symlink, and `sameWorkspace` compares the strings.
  meta: {
    cwd: process.env.REAL_MODEL_XPROC_WORKSPACE ?? process.cwd(),
    ...(presetId === undefined ? {} : { agentPreset: presetId }),
  },
  agentOptions: {
    provider: process.env.REAL_MODEL_PROVIDER,
    model: process.env.REAL_MODEL_MODEL,
    reasoningEffort: process.env.REAL_MODEL_EFFORT ?? 'low',
  },
  setup:
    presetId === undefined
      ? undefined
      : async (agentCtx) => {
          await presets.mount(agentCtx, presetId);
        },
});

console.log(`HOST-READY ${hostId}`);
console.log(`HOST-ENDPOINT ${(await bus.xproc())?.endpointId ?? 'none'}`);

process.on('SIGTERM', () => {
  void (async () => {
    await shutdown?.shutdown?.(0);
    process.exit(0);
  })();
});

// Hold the session live. Every real event — a delivered message, a model turn, a
// socket frame — is handled by the loop as usual.
await new Promise(() => {});
