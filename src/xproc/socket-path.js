/**
 * Where a cross-process endpoint's socket lives.
 *
 * The path is not a free choice. A Unix domain socket address is a fixed-size
 * `sockaddr_un.sun_path` buffer — 104 bytes on macOS/BSD including the trailing
 * NUL, 108 on Linux — and an over-long path fails with `ENAMETOOLONG` at bind
 * time rather than being truncated. `$DSH_HOME` is user-chosen and can easily be
 * long (`~/Library/Application Support/...`), so the preferred location is
 * checked against that limit and a short temporary directory is used when it does
 * not fit.
 *
 * Windows has no such limit: it uses named pipes in their own namespace.
 *
 * Everything OS-specific is injectable so the fallback logic is testable without
 * actually creating a long path or running on Windows.
 *
 * @module dsh-peer-bus/xproc/socket-path
 */
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Usable `sun_path` bytes, excluding the terminator: macOS/BSD is the tighter of the two. */
const SUN_PATH_MAX = 103;

/** Directory holding one process's registry entry and token, under `$DSH_HOME`. */
const endpointDir = (home) => join(home, 'peer-bus', 'endpoints');

/** Preferred directory for socket files, under `$DSH_HOME`. */
const socketDir = (home) => join(home, 'peer-bus', 's');

/**
 * A stable short name for one endpoint's socket file.
 *
 * The endpoint id already carries the pid, but a socket name has to stay short, so
 * the id is hashed rather than used verbatim.
 *
 * @param endpointId - this process's endpoint id.
 * @returns a short filename-safe token.
 */
const shortName = (endpointId) => createHash('sha256').update(endpointId).digest('hex').slice(0, 16);

/**
 * The Windows named-pipe path for one endpoint.
 *
 * Named pipes live in their own namespace, so the home directory only contributes
 * a hash — two different `DSH_HOME`s must not collide, and the pipe name must not
 * leak the path.
 *
 * @param home - resolved DSH home.
 * @param endpointId - this process's endpoint id.
 * @returns the pipe path.
 */
const pipePath = (home, endpointId) =>
  `\\\\.\\pipe\\dsh-peer-bus-${createHash('sha256').update(home).digest('hex').slice(0, 12)}-${shortName(endpointId)}`;

/**
 * The socket path for one endpoint, preferring the DSH home and falling back.
 *
 * @param options - home and endpoint id, plus injectable platform facts.
 * @returns the socket path to bind, and which location it came from.
 */
function socketPathFor({ home, endpointId, platform = process.platform, uid = process.getuid?.(), tmp = tmpdir() }) {
  if (platform === 'win32') {
    return { socket: pipePath(home, endpointId), location: 'pipe', fallback: false };
  }
  const preferred = join(socketDir(home), `${shortName(endpointId)}.sock`);
  // Byte length, not character count: a non-ASCII home can be shorter in
  // characters than the limit and longer in the bytes the kernel actually counts.
  if (Buffer.byteLength(preferred) <= SUN_PATH_MAX) {
    return { socket: preferred, location: 'home', fallback: false };
  }
  const owner = uid === undefined ? 'nouid' : String(uid);
  const fallback = join(tmp, `dsh-pb-${owner}`, `${shortName(endpointId)}.sock`);
  return { socket: fallback, location: 'tmp', fallback: true };
}

export { SUN_PATH_MAX, endpointDir, pipePath, shortName, socketDir, socketPathFor };
