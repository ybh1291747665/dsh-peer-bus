/**
 * Prepare the throwaway DSH home every check script boots: `.dsh-test/`.
 *
 * `.dsh-test/` is gitignored, so a fresh clone has no profiles to boot and the
 * boot/e2e/restart scripts fail with an unresolvable plugin. This script builds
 * the same thing `dsh plugin --profile <name> add <path>` builds, idempotently:
 * a profile directory per bundled profile, with this package as a `link:`
 * dependency and as a bundle layer, plus the `node_modules` entry that makes the
 * package resolvable from inside the profile.
 *
 * It deliberately does not need `dsh` or `pnpm` on PATH, and it never touches
 * `~/.dsh`: `./dsh-home.mjs` pins `DSH_HOME` here first.
 *
 * It also prunes the sessions earlier check runs left behind. `e2e-bus.mjs`
 * removes its own, but a run killed part-way cannot, and `restart-e2e` needs its
 * two sessions to survive *between* its own phases — so the sweep lives here
 * rather than in every script. Only ids this repo's checks generate are touched;
 * the roster is rebuilt on every send, so a home that grows without bound makes
 * the whole suite slower and the documented linear cost unmeasurable.
 *
 * Usage: node scripts/setup-test-home.mjs
 */
// Pin DSH_HOME to the repo test home before anything reads it.
import './dsh-home.mjs';
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.DSH_HOME;

/** Session-id prefixes this repository's checks create. */
const CHECK_SESSION_PREFIXES = ['session-e2e-', 'session-restart-', 'session-xproc-'];

/**
 * Each profile, its base bundles, and whether this package's own bundle layer is
 * part of the composition.
 *
 * Exactly one layer may mount the bus, because a patch `insert` **appends**: it
 * does not replace a row with the same id. Bundling the package *and* inserting
 * it from an overlay therefore mounts two buses — two services under one name,
 * two sets of tools, and two owners for anything the bus holds durably. So the
 * two profiles deliberately cover the two mounting paths instead:
 *
 *   headless  mounted by the overlay, so `bus.patch.yml` and
 *             `bus.e2e.patch.yml` are the only mount and stay usable on a profile
 *             that does not bundle the package at all.
 *   web       mounted by the package's own bundle layer, so the shipped
 *             `cordis.patch.yml` — the thing a real `dsh plugin add` composes —
 *             is what gets exercised.
 */
const PROFILES = {
  headless: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
    bundlePlugin: false,
  },
  web: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    bundlePlugin: true,
  },
};

for (const [profile, { bundles, bundlePlugin }] of Object.entries(PROFILES)) {
  const dir = join(home, 'profiles', profile);
  mkdirSync(join(dir, 'node_modules'), { recursive: true });

  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${profile}`,
        private: true,
        dependencies: { 'dsh-peer-bus': `link:${projectRoot}` },
        dsh: { profile: { bundles: bundlePlugin ? [...bundles, 'dsh-peer-bus'] : bundles } },
      },
      null,
      2,
    )}\n`,
  );

  // `cordis.yml`, `pnpm-workspace.yaml`, and the lockfile are DSH's to write on
  // first boot; only the resolution entry has to exist beforehand.
  const link = join(dir, 'node_modules', 'dsh-peer-bus');
  rmSync(link, { recursive: true, force: true });
  symlinkSync(projectRoot, link, 'dir');

  console.log(
    `prepared profile "${profile}" in ${dir} (bus mounted by ${bundlePlugin ? 'its bundle layer' : 'the overlay'})`,
  );
}

console.log(`test home ready: ${home}`);

/**
 * Delete session directories and projection caches left by earlier check runs.
 *
 * @returns how many session directories were removed.
 */
function pruneCheckSessions() {
  let removed = 0;
  const sessionsDir = join(home, 'sessions');
  for (const bucket of readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const bucketDir = join(sessionsDir, bucket.name);
    for (const session of readdirSync(bucketDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      if (!CHECK_SESSION_PREFIXES.some((prefix) => session.name.startsWith(prefix))) continue;
      rmSync(join(bucketDir, session.name), { recursive: true, force: true });
      removed += 1;
    }
  }
  // The cross-process transport's registry. A killed peer leaves its entry behind;
  // the next endpoint prunes it by pid anyway, but a check home should start empty.
  rmSync(join(home, 'peer-bus'), { recursive: true, force: true });
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions');
  for (const cached of readdirSync(cacheDir).filter((name) => CHECK_SESSION_PREFIXES.some((prefix) => name.startsWith(prefix)))) {
    rmSync(join(cacheDir, cached), { force: true });
  }
  return removed;
}

// `readdirSync` throws on a home that has never booted; there is nothing to prune then.
let pruned = 0;
try {
  pruned = pruneCheckSessions();
} catch {
  pruned = 0;
}
if (pruned > 0) console.log(`pruned ${pruned} session(s) left by earlier check runs`);
