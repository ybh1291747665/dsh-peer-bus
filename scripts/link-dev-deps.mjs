/**
 * Link the DSH runtime packages this plugin needs into ./node_modules so the
 * test suite and the boot/e2e scripts can run from a source checkout.
 *
 * A real install resolves these through the profile's own pnpm store; this script
 * only exists because a bare checkout has no `@deepseek-ai/*` packages. It finds
 * the DSH install rather than hardcoding a path, in this order:
 *
 *   1. `--dsh <path>` argument
 *   2. `$DSH_INSTALL` environment variable
 *   3. the `dsh` executable on PATH, following it to its package root
 *   4. `@deepseek-ai/dsh` resolved as a module from here
 *
 * Usage: node scripts/link-dev-deps.mjs [--dsh <path-to-dsh-package>]
 */
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

/** Packages the source imports directly, plus what the scripts import. */
const packages = [
  // imported by src/
  'cordis',
  'schemastery',
  'dsh-agent',
  'dsh-llm',
  'dsh-session',
  'dsh-tools',
  // imported by scripts/ (profile boot, stub adapter, e2e, invariant checks)
  'dsh-app-boot',
  'dsh-home-paths',
  'dsh-invariants',
  'dsh-launch-environment',
];

/**
 * Non-scoped runtime packages the plugin resolves lazily, and only if the install
 * carries them. `zod` is what the storage domain layer validates durable records
 * with, so the runtime allowlist is only durable where it resolves; linking it
 * here is what lets the checks exercise that path from a bare checkout.
 */
const unscopedPackages = ['zod'];

/**
 * Locate the `@deepseek-ai/dsh` package directory.
 *
 * @returns the absolute package directory.
 * @throws when no candidate resolves to a real DSH install.
 */
function findDshInstall() {
  const flagIndex = process.argv.indexOf('--dsh');
  const candidates = [];

  if (flagIndex !== -1 && process.argv[flagIndex + 1] !== undefined) {
    candidates.push(resolve(process.argv[flagIndex + 1]));
  }
  if (process.env.DSH_INSTALL !== undefined) candidates.push(resolve(process.env.DSH_INSTALL));

  // Follow the `dsh` executable: <pkg>/lib/bin.js -> the package root above lib/.
  // Searched by hand rather than through a shell, which avoids a deprecation
  // warning and works without a `which` binary.
  const pathEntries = (process.env.PATH ?? '').split(':').filter((entry) => entry !== '');
  for (const entry of pathEntries) {
    const candidateBin = join(entry, 'dsh');
    if (!existsSync(candidateBin)) continue;
    try {
      candidates.push(resolve(realpathSync(candidateBin), '..', '..'));
    } catch {
      // A dangling symlink on PATH is not fatal; try the next source.
    }
    break;
  }

  try {
    const require = createRequire(import.meta.url);
    candidates.push(dirname(require.resolve('@deepseek-ai/dsh/package.json')));
  } catch {
    // Not resolvable as a dependency either.
  }

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'node_modules/@deepseek-ai'))) return candidate;
  }

  console.error('could not find a DSH install. Tried:');
  for (const candidate of candidates) console.error(`  - ${candidate}`);
  console.error('\npass one explicitly:  node scripts/link-dev-deps.mjs --dsh <path to @deepseek-ai/dsh>');
  process.exit(1);
}

const dshRoot = findDshInstall();
const scopeDir = join(projectRoot, 'node_modules/@deepseek-ai');
rmSync(scopeDir, { recursive: true, force: true });
mkdirSync(scopeDir, { recursive: true });

let linked = 0;
const missing = [];
for (const packageName of packages) {
  const target = join(dshRoot, 'node_modules/@deepseek-ai', packageName);
  if (!existsSync(target)) {
    missing.push(packageName);
    continue;
  }
  symlinkSync(target, join(scopeDir, packageName), 'dir');
  linked += 1;
}

// The boot/e2e scripts import `@deepseek-ai/dsh/profile-boot`, which lives in the
// CLI package itself rather than a dependency.
const dshEntry = join(projectRoot, 'node_modules/@deepseek-ai/dsh');
rmSync(dshEntry, { force: true });
symlinkSync(dshRoot, dshEntry, 'dir');

let linkedUnscoped = 0;
for (const packageName of unscopedPackages) {
  const target = join(dshRoot, 'node_modules', packageName);
  const link = join(projectRoot, 'node_modules', packageName);
  rmSync(link, { recursive: true, force: true });
  if (!existsSync(target)) continue;
  symlinkSync(target, link, 'dir');
  linkedUnscoped += 1;
}

console.log(`linked ${linked} packages + the dsh CLI from ${dshRoot}`);
if (linkedUnscoped > 0) console.log(`linked ${linkedUnscoped} lazily-resolved package(s): ${unscopedPackages.join(', ')}`);
if (missing.length > 0) {
  // An optional peer that the install does not carry is expected, not an error:
  // dsh-invariants ships only in dsh-sdk-minimal profiles.
  console.log(`not present in this install (optional): ${missing.join(', ')}`);
}
