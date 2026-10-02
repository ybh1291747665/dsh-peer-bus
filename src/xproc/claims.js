/**
 * Cross-process claims on a session that is being cold-resumed.
 *
 * The problem this solves is not one the layer below can solve. A session's log is
 * guarded by a cross-process `flock(2)`, but that lock guards **write handles**, and
 * `agents.resume` does not take one — so two processes that decide to resume the same
 * stored session at the same moment both succeed, and both come away believing they
 * own it. Nothing in the resume's return value says otherwise.
 *
 * So the bus arbitrates among its own processes, which is exactly the population at
 * risk: a session nobody holds can only be resumed by a bus, and only bus processes
 * are contending for it. The arbiter is `open(…, 'wx')`, which is atomic in the
 * kernel — one creator, everyone else gets `EEXIST`.
 *
 * A claim is held for as long as the process owns the session, not merely for the
 * length of the resume, because the loser's next move is to *forward* to the winner:
 * it has to still be the winner when the message arrives.
 *
 * @module dsh-peer-bus/xproc/claims
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';

/** Owner-only, like the rest of the transport's on-disk state. */
const DIR_MODE = 0o700;

/** Owner-only: a claim names a pid and an endpoint, which is nobody else's business. */
const FILE_MODE = 0o600;

/**
 * Whether a pid names a process that still exists.
 *
 * `EPERM` means it exists but belongs to someone else — alive, and not ours to reap.
 *
 * @param pid - candidate process id.
 * @returns true when the process exists.
 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Who currently claims the sessions this process is trying to resume.
 */
class ClaimBook {
  /**
   * @param options - resolved home, this process's endpoint id, and a logger.
   */
  constructor({ home, endpointId, logger }) {
    this.dir = join(home, 'peer-bus', 'claims');
    this.endpointId = endpointId;
    this.logger = logger;
    /** session id → the file this process created for it. */
    this.held = new Map();
  }

  /**
   * The claim file for one session.
   *
   * Hashed because a session id is not necessarily a filename-safe string, and a
   * fixed-length name keeps every claim inside the directory's own limits.
   *
   * @param sessionId - the session being claimed.
   * @returns the absolute path.
   */
  fileFor(sessionId) {
    return join(this.dir, `${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`);
  }

  /**
   * Try to become the process that resumes this session.
   *
   * @param sessionId - the session to claim.
   * @returns `{acquired: true}` when this process now owns the claim, otherwise
   *   `{acquired: false, owner}` describing who holds it.
   */
  async acquire(sessionId) {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    await chmod(this.dir, DIR_MODE).catch(() => {});
    const file = this.fileFor(sessionId);

    // Two passes: the first may find a claim whose owner has died, which is then
    // cleared and retried. A second failure means a live owner took it in between.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(file, 'wx', FILE_MODE);
        try {
          await handle.writeFile(
            `${JSON.stringify({ pid: process.pid, endpointId: this.endpointId, sessionId, at: Date.now() })}\n`,
          );
        } finally {
          await handle.close();
        }
        await chmod(file, FILE_MODE).catch(() => {});
        this.held.set(sessionId, file);
        return { acquired: true };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }

      const owner = await this.read(file);
      // A claim naming *this* process, for a session this process is not running, is
      // stale by definition — some release path did not run. Reclaiming it here is the
      // safety net for that, and it is what keeps a missed release from making the
      // session permanently unresumable for everyone, this process included.
      const ours = owner !== undefined && owner.endpointId === this.endpointId;
      if (owner !== undefined && isAlive(owner.pid) && !ours) {
        return { acquired: false, owner };
      }
      // A dead owner, our own leftover, or a file we cannot read: none of them is a
      // live claim by somebody else, so clear it and try once more.
      await rm(file, { force: true }).catch(() => {});
    }
    return { acquired: false, owner: undefined };
  }

  /**
   * Read one claim file.
   *
   * @param file - the claim file.
   * @returns the parsed claim, or undefined when it is missing or unreadable.
   */
  async read(file) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      return typeof parsed?.pid === 'number' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Look at a claim without taking it.
   *
   * @param sessionId - the session to look up.
   * @returns the current owner, or undefined when nobody holds it.
   */
  async ownerOf(sessionId) {
    const owner = await this.read(this.fileFor(sessionId));
    return owner !== undefined && isAlive(owner.pid) ? owner : undefined;
  }

  /**
   * Give up one claim.
   *
   * Only removes the file if it still names this process: after a takeover, the file
   * belongs to the new owner and deleting it would hand the session to a third
   * contender.
   *
   * @param sessionId - the session to release.
   */
  async release(sessionId) {
    const file = this.held.get(sessionId);
    if (file === undefined) return;
    this.held.delete(sessionId);
    const owner = await this.read(file);
    if (owner !== undefined && owner.endpointId !== this.endpointId) return;
    await rm(file, { force: true }).catch(() => {});
  }

  /**
   * Give up every claim this process holds.
   *
   * Called on unload, so a clean shutdown leaves nothing behind for the next process
   * to wait on. A process that is killed instead leaves its files, and the dead pid
   * in them is what lets the next contender take over.
   */
  async releaseAll() {
    for (const sessionId of [...this.held.keys()]) await this.release(sessionId);
  }
}

export { ClaimBook, DIR_MODE, FILE_MODE, isAlive };
