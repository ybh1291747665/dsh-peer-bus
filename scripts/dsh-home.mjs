/**
 * Point `DSH_HOME` at this repo's throwaway test home before anything reads it.
 *
 * Every script here boots the real DSH profile machinery, which rewrites profile
 * files under `DSH_HOME`. The ambient `DSH_HOME` belongs to the developer's real
 * installation — a DSH session exports its own home to every child shell — so it
 * is deliberately **overridden**, never inherited: a direct `node scripts/…`
 * invocation must not be able to write into `~/.dsh`. Set `BUS_TEST_DSH_HOME` to
 * aim the scripts at a different throwaway home.
 *
 * Import this **first**, before any `@deepseek-ai/dsh-*` import: ES modules are
 * evaluated in import order, and the loader reads `DSH_HOME` while those modules
 * initialise.
 *
 * @module scripts/dsh-home
 */
import { fileURLToPath } from 'node:url';

process.env.DSH_HOME = process.env.BUS_TEST_DSH_HOME ?? fileURLToPath(new URL('../.dsh-test', import.meta.url));
