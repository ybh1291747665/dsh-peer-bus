/**
 * Boot the real DSH profile machinery with the peer-bus overlay and assert
 * that the plugin mounted: its service is present and its six tools registered.
 *
 * This exercises the actual loader path (`runProfile` -> profile patch layers ->
 * plugin `apply()`), which is what a `dsh plugin add` install would do, without
 * touching the user's own profile directory.
 *
 * Usage: node scripts/boot-check.mjs
 *
 * `DSH_HOME` is pinned to the repo's throwaway test home by ./dsh-home.mjs, so a
 * check never writes into a real installation. Env knobs:
 *
 *   BUS_CHECK_PROFILE  profile to boot (default `headless`)
 *   BUS_CHECK_PATCH    comma-separated overlays, applied in order
 *                      (default `../bus.patch.yml`)
 *   BUS_TEST_DSH_HOME  a different throwaway DSH home
 */
// Pin DSH_HOME to the repo test home before the DSH loader reads it.
import "./dsh-home.mjs";
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';

const PROFILE = process.env.BUS_CHECK_PROFILE ?? 'headless';
// Default to the production overlay. Point BUS_CHECK_PATCH at the e2e overlay to
// check the same plugin against a profile that mounts the extra services the
// scripts rely on (the workspace registry, the preset registry).
// Several overlays may be listed, comma-separated, and are applied in order:
// `../web-noserver.patch.yml` last is what lets the `web` profile be checked
// without binding the port a running DSH already holds.
const PATCHES = (process.env.BUS_CHECK_PATCH ?? '../bus.patch.yml')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry !== '');
// `--no-open` keeps a web-profile check from launching a browser window. The
// headless profile has no such flag and rejects unknown arguments.
//
// DSH 0.2.1 made the headless profile reject a boot with no task outright
// ("error: a task is required"), so an empty argv no longer boots far enough to
// mount anything — which used to read as "the plugin did not apply" and was not.
// A headless check therefore needs an explicit BUS_CHECK_TASK (it really runs the
// agent, so it costs a model call); `npm run boot-check:web` stays the free path.
const ARGS = PROFILE === 'web'
  ? ['--no-open']
  : (process.env.BUS_CHECK_TASK ? [process.env.BUS_CHECK_TASK] : []);
if (PROFILE !== 'web' && ARGS.length === 0) {
  console.error(
    'boot-check: DSH 0.2.1 requires a task for a non-web profile.\n' +
      '  free:   npm run boot-check:web\n' +
      '  or set: BUS_CHECK_TASK="say hi" npm run boot-check   (runs the agent, costs a model call)',
  );
  process.exit(1);
}

const environment = createLaunchEnvironmentSnapshot([
  {
    source: 'process',
    values: Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
    ),
  },
]);

let booted;
try {
  booted = await runProfile({
    environment,
    profile: PROFILE,
    patchFiles: PATCHES.map((entry) => new URL(entry, import.meta.url).pathname),
    args: ARGS,
  });
} catch (error) {
  console.error(`boot-check: the profile "${PROFILE}" did not boot: ${error?.message ?? error}`);
  console.error('  That is a BOOT failure, not a plugin failure — no plugin could have applied.');
  process.exit(1);
}
const { ctx, shutdown } = booted;

const failures = [];

// Gate on the boot, not on the plugin.
//
// A boot that never finished has no tool registry on the context at all, and every
// check below then reports "not registered" — a wall of failures that all have the
// same single cause and none of which say anything about this package. That is
// exactly how a rejected argv once presented as a broken plugin: DSH 0.2.1 refuses
// a headless boot with no task, nothing mounts, and the output blamed peer-bus.
// So ask first whether the profile came up, and say so plainly if it did not.
const tools = ctx.get('tools');
if (tools === undefined) {
  console.error(
    `boot-check: the profile "${PROFILE}" did not boot far enough to mount plugins —\n` +
      '  there is no tool registry on the context. The plugin checks are skipped, because\n' +
      '  every one of them would "fail" for that one reason and mean nothing.\n' +
      '  Usual causes: a rejected argv (since DSH 0.2.1 a non-web profile needs a task),\n' +
      '  or a dependency that failed to activate. The diagnostics above say which.',
  );
  await shutdown?.shutdown?.(1);
  process.exit(1);
}

const bus = ctx.get('peerBus');
if (bus === undefined) failures.push('ctx.get("peerBus") is undefined — the plugin did not apply');

const BUS_TOOLS = ['bus_roster', 'bus_send', 'bus_ask', 'bus_reply', 'bus_status', 'bus_wait'];
for (const toolName of BUS_TOOLS) {
  if (tools?.get?.(toolName) === undefined) failures.push(`tool ${toolName} was not registered`);
}

// DSH 0.2.1 removed the runtime invariants plugin and every package's
// `./invariant` export, and `@deepseek-ai/dsh-invariants` is no longer present
// in the install. There is no companion to report on any more.
const companionState = 'removed with DSH 0.2.1 (no ./invariant companion)';

if (failures.length === 0) {
  // NOTE: this call must stay in the same tick as `runProfile` resolving.
  // `bus.patch.yml` does not disable `headless-runner`, and with no task it begins
  // shutting the profile down immediately — so anything that crosses a macrotask
  // first (an `await sleep()`, a network read, a second `await`) reaches a fiber
  // that is already inactive and fails with "cannot get required service ... in
  // inactive context". That reads like a plugin bug and is not one: with
  // `headless-runner` disabled (bus.e2e.patch.yml) every timing works. Keep the
  // checks here synchronous, or move them to the e2e overlay.
  //
  // This is also the regression check for Cordis's service shadow: `bus` comes
  // from `ctx.get('peerBus')`, so its methods run with `this.ctx` rebound to a
  // per-call shadow, and the allowlist domain opens on real file I/O — an await
  // that crosses a macrotask. Any service lookup still going through the shadowed
  // `this.ctx` returns undefined here and takes the whole check down.
  const roster = await bus.roster();
  // Archive protection is optional: only the web bundle mounts `workspaceRegistry`.
  // Pin both directions here — a profile without it must behave exactly as if
  // nothing were archived, and one with it must agree with the registry.
  const registry = ctx.get('workspaceRegistry');
  const archived = bus.archivedIds();
  let archiveState;
  if (registry === undefined) {
    archiveState = 'absent — archive protection inert';
    if (archived.size !== 0) {
      failures.push('the bus reports archived sessions on a profile with no workspace registry');
    }
  } else {
    archiveState = `mounted — ${archived.size} archived`;
    if (archived.size !== new Set(registry.archivedSessionIds).size) {
      failures.push('the bus disagrees with the workspace registry about archived sessions');
    }
  }
  // Which cold-resume path this profile gets is decided by composition, so report
  // it rather than leaving it to be inferred: the host's Typert `agent` lookup is
  // configured only by a session controller (web bundle).
  const controller = ctx.get('sessionController');
  const hostLookup = ctx.get('typert')?.lookups?.get?.('agent');
  let resumeState;
  if (controller === undefined) {
    resumeState = 'manual (no session controller on this profile)';
  } else if (hostLookup === undefined) {
    resumeState = 'BROKEN — a session controller is mounted but no agent lookup exists';
    failures.push('the session controller is mounted but the agent lookup is missing');
  } else {
    resumeState = 'host agent lookup';
  }
  if (failures.length === 0) {
    console.log(`boot-check OK: peer-bus mounted on profile "${PROFILE}"`);
    console.log(`  roster entries: ${roster.length}`);
    console.log(`  tools: ${BUS_TOOLS.join(', ')}`);
    console.log(`  ./invariant companion: ${companionState}`);
    console.log(`  workspace registry: ${archiveState}`);
    console.log(`  cold resume: ${resumeState}`);
  }
}

if (failures.length > 0) {
  console.error('boot-check FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
}

await shutdown?.shutdown?.(failures.length === 0 ? 0 : 1);
process.exit(failures.length === 0 ? 0 : 1);
