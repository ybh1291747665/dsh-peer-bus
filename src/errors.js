/**
 * The one error type every bus rejection uses.
 *
 * It lives in its own module so that the bus, the ask registry, and the command
 * layer can all name it without importing each other: `peer-bus` imports `ask`,
 * so `ask` importing `peer-bus` back for the class would be a cycle.
 *
 * @module dsh-peer-bus/errors
 */

/**
 * Thrown for every rejected bus operation.
 *
 * `code` is the stable discriminator — callers branch on it, and it is what the
 * model tools surface. The message is for a human and may change.
 */
class SessionBusError extends Error {
  /**
   * @param message - human-readable failure account.
   * @param code - stable machine discriminator for callers.
   */
  constructor(message, code) {
    super(message);
    this.name = 'SessionBusError';
    this.code = code;
  }
}

export { SessionBusError };
