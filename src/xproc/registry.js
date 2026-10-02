/**
 * Who else is listening, and how to prove we are allowed to talk to them.
 *
 * One JSON file per live DSH process under `$DSH_HOME/peer-bus/endpoints/`, plus a
 * token file beside it. Discovery is deliberately scoped to a single `DSH_HOME`:
 * two DSH homes on one machine are two separate worlds, even for the same user.
 *
 * **The trust boundary is "same OS user", and it is enforced by file permissions,
 * not by the token.** The directory is `0700` and the files are `0600`, so another
 * user cannot enumerate peers or read a token. The token is a second lock rather
 * than the first one, and it matters most on Windows, where a named pipe has no
 * filesystem permission model of its own and any local process can attempt to
 * connect.
 *
 * @module dsh-peer-bus/xproc/registry
 */
import { mkdir, readFile, readdir, rename, rm, writeFile, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { endpointDir } from './socket-path.js';

/** Registry file format; bumped when the shape changes incompatibly. */
const REGISTRY_VERSION = 1;

/** Owner-only for directories. */
const DIR_MODE = 0o700;

/** Owner-only for files: a peer's token must not be world-readable. */
const FILE_MODE = 0o600;

/**
 * Whether a pid names a process that still exists.
 *
 * `EPERM` means the process exists but belongs to someone else — still alive, and
 * still worth leaving alone. Any other failure is treated as gone.
 *
 * @param pid - candidate process id.
 * @returns true when the process exists.
 */
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Create a directory that only its owner can enter, whatever the umask says.
 *
 * Inside `$DSH_HOME` a plain `mkdir` is enough: the parent is already ours. A
 * *shared* parent is a different problem — on Linux `$TMPDIR` is `/tmp`, which any
 * user can write to, so a directory there can be pre-created by someone else, or
 * created as a symlink pointing wherever they like. For those, `strict` verifies what
 * actually exists instead of trusting that we made it: a real directory (not a
 * symlink), owned by us, mode 0700. Anything else refuses rather than quietly putting
 * a listening socket in a directory someone else controls.
 *
 * @param dir - directory to create or verify.
 * @param options - `strict` when the parent is shared with other users.
 * @returns fulfillment once it exists and passes the checks.
 * @throws {Error} when a strict directory is not ours to use.
 */
async function ensurePrivateDir(dir, { strict = false } = {}) {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  if (!strict) {
    // `mkdir` applies `mode & ~umask`, so a permissive umask would widen this. The
    // explicit chmod is what actually guarantees the boundary.
    await chmod(dir, DIR_MODE).catch(() => {});
    return;
  }

  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`refusing to use ${dir}: it exists but is not a real directory`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`refusing to use ${dir}: it is owned by uid ${info.uid}, not ${uid}`);
  }
  if ((info.mode & 0o777) !== DIR_MODE) {
    throw new Error(
      `refusing to use ${dir}: mode is ${(info.mode & 0o777).toString(8)}, expected 700`,
    );
  }
}

/**
 * Write a file only its owner can read, atomically.
 *
 * Atomic because a peer enumerating the directory must never observe a
 * half-written entry and conclude something false about a live process.
 *
 * @param file - destination path.
 * @param contents - text to write.
 */
async function writePrivateFile(file, contents) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: FILE_MODE });
  await chmod(temporary, FILE_MODE).catch(() => {});
  await rename(temporary, file);
}

/**
 * One process's presence record: its registry entry, its token, and the peers it
 * can currently see.
 */
class EndpointRegistry {
  /**
   * @param options - resolved home, this endpoint's identity, and its socket path.
   */
  constructor({ home, endpointId, socket, profile, version }) {
    this.home = home;
    this.endpointId = endpointId;
    this.socket = socket;
    this.profile = profile;
    this.version = version;
    this.dir = endpointDir(home);
    /** Minted once per process; never written anywhere but this endpoint's own file. */
    this.token = '';
  }

  /** Path of this endpoint's registry entry. */
  get entryFile() {
    return join(this.dir, `${this.endpointId}.json`);
  }

  /** Path of this endpoint's token file. */
  get tokenFile() {
    return join(this.dir, `${this.endpointId}.token`);
  }

  /**
   * Announce this endpoint and write its token.
   *
   * @param token - the shared secret peers must present.
   * @returns fulfillment once both files are durable.
   */
  async publish(token) {
    this.token = token;
    await ensurePrivateDir(this.dir);
    await writePrivateFile(this.tokenFile, token);
    await writePrivateFile(
      this.entryFile,
      `${JSON.stringify(
        {
          v: REGISTRY_VERSION,
          endpointId: this.endpointId,
          pid: process.pid,
          socket: this.socket,
          profile: this.profile,
          version: this.version,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }

  /**
   * Withdraw this endpoint.
   *
   * Best-effort: a process that is exiting must not fail on a missing file, and a
   * leftover entry is cleaned up by the next peer's staleness sweep anyway.
   *
   * @returns fulfillment once both files are gone or known absent.
   */
  async unpublish() {
    await rm(this.entryFile, { force: true }).catch(() => {});
    await rm(this.tokenFile, { force: true }).catch(() => {});
  }

  /**
   * Read every well-formed entry, excluding this endpoint.
   *
   * A malformed or unreadable file is skipped rather than fatal: one broken peer
   * must not make the whole bus unusable.
   *
   * @returns parsed entries, newest first.
   */
  async entries() {
    const names = await readdir(this.dir).catch(() => []);
    const found = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const endpointId = name.slice(0, -'.json'.length);
      if (endpointId === this.endpointId) continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.dir, name), 'utf8'));
        if (parsed?.v !== REGISTRY_VERSION) continue;
        if (parsed.endpointId !== endpointId) continue;
        if (typeof parsed.socket !== 'string' || parsed.socket === '') continue;
        if (!Number.isInteger(parsed.pid)) continue;
        found.push(parsed);
      } catch {
        // Skip: an unreadable or half-removed entry is not a peer.
      }
    }
    return found.sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)));
  }

  /**
   * Read one peer's token.
   *
   * @param endpointId - peer to read.
   * @returns the token, or undefined when the peer has gone or is unreadable.
   */
  async tokenFor(endpointId) {
    try {
      return (await readFile(join(this.dir, `${endpointId}.token`), 'utf8')).trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Drop entries whose process is gone.
   *
   * Only a dead pid is grounds for removal here. A socket that refuses connections
   * is *not*: a peer can be mid-startup between publishing its entry and binding,
   * and deleting its record then would make it undiscoverable for good.
   *
   * @returns the endpoint ids that were removed.
   */
  async prune() {
    const removed = [];
    for (const entry of await this.entries()) {
      if (isProcessAlive(entry.pid)) continue;
      await rm(join(this.dir, `${entry.endpointId}.json`), { force: true }).catch(() => {});
      await rm(join(this.dir, `${entry.endpointId}.token`), { force: true }).catch(() => {});
      removed.push(entry.endpointId);
    }
    return removed;
  }

  /**
   * Forget one peer immediately, after a connection proved it is gone.
   *
   * @param endpointId - peer whose entry and token should be removed.
   */
  async forget(endpointId) {
    await rm(join(this.dir, `${endpointId}.json`), { force: true }).catch(() => {});
    await rm(join(this.dir, `${endpointId}.token`), { force: true }).catch(() => {});
  }
}

export { DIR_MODE, EndpointRegistry, FILE_MODE, REGISTRY_VERSION, ensurePrivateDir, isProcessAlive, writePrivateFile };
