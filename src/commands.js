/**
 * `/bus` — the human-facing half of the bus.
 *
 * This exists because the config allowlist cannot be written ahead of time: a
 * session id is a fresh UUID, so "let me test two sessions talking" would
 * otherwise mean editing a YAML file and restarting DSH after both sessions
 * already exist. A slash command removes that round trip without a GUI.
 *
 * **Semantics: the grant is receiver consent.** `/bus allow <session>` run in
 * session A means *that session may message A*. Each side's user decides who may
 * instruct it, so a two-way conversation takes one grant on each side. The
 * alternative — one grant opening both directions — would let A's user decide, on
 * B's behalf, who may instruct B.
 *
 * **Deliberately not a model tool.** Nothing here is exposed to a model: a
 * compromised or confused agent must not be able to widen its own permissions.
 * The only way to change the allowlist is for a human to type the command.
 *
 * @module dsh-peer-bus/commands
 */
import { SessionBusError } from './peer-bus.js';

/** Usage line shared by the help text and the unknown-subcommand error. */
const USAGE = 'id | list | allow <session> | revoke <session>';

/**
 * Help text, including this session's own id so the user can paste it to a peer.
 *
 * @param agent - the calling agent.
 * @returns the help body.
 */
const helpText = (agent) =>
  [
    `peer-bus allowlist for ${agent.id}`,
    '',
    `  /bus ${USAGE}`,
    '',
    '  id       show this session\'s id',
    '  list     who may message this session, and why',
    '  allow    let <session> message this session',
    '  revoke   take that back (undoes /bus allow, not the config)',
    '',
    '<session> is a full session id or an unambiguous id prefix.',
    'The allowlist is per direction: each side grants the other separately,',
    'because each side\'s user decides who may instruct it.',
  ].join('\n');

/**
 * Resolve an address and the two rows a permission decision needs.
 *
 * @param bus - the bus service.
 * @param me - the calling agent.
 * @param address - full session id or unambiguous prefix.
 * @returns the peer row, this session's row, and the resolved peer id.
 * @throws {SessionBusError} `unknown-target` or `ambiguous-target`.
 */
async function contextFor(bus, me, address) {
  const rows = await bus.roster();
  const peerId = bus.resolveIn(rows, address);
  return {
    peerId,
    peerRow: rows.find((row) => row.id === peerId) ?? { id: peerId },
    myRow: rows.find((row) => row.id === me.id) ?? bus.rowOf(me),
  };
}

/**
 * Render the error for an address that cannot be resolved.
 *
 * A grant is stored by full id, so a typo must fail loudly rather than persist a
 * dead entry that would silently never match.
 *
 * @param bus - the bus service.
 * @param me - the calling agent.
 * @param address - the raw address.
 * @returns `{ error }` when the address is unusable, or the resolved context.
 */
async function resolveForGrant(bus, me, address) {
  try {
    return { context: await contextFor(bus, me, address) };
  } catch (error) {
    if (!(error instanceof SessionBusError)) throw error;
    return { error: `cannot resolve "${address}": ${error.message}` };
  }
}

/**
 * Handle `/bus allow`.
 *
 * @param bus - the bus service.
 * @param me - the calling agent.
 * @param address - the raw address argument.
 * @returns a command result.
 */
async function allow(bus, me, address) {
  if (address === '') return { kind: 'error', text: `usage: /bus allow <session>. Use: /bus ${USAGE}` };
  const resolved = await resolveForGrant(bus, me, address);
  if (resolved.error !== undefined) return { kind: 'error', text: resolved.error };
  const { peerId, peerRow, myRow } = resolved.context;
  if (peerId === me.id) {
    return { kind: 'error', text: 'a session cannot grant itself permission to message itself' };
  }
  const byConfig = bus.isAllowedByConfig(peerRow, myRow);
  const created = await bus.allowlist.grant(peerId, me.id);
  return {
    kind: 'success',
    text: [
      created
        ? `Granted: ${peerId} may message this session.`
        : `${peerId} already had a runtime grant to message this session.`,
      byConfig
        ? 'The config allowlist already permitted this pair, so this grant is redundant.'
        : undefined,
      `The other direction is separate: they must run /bus allow ${me.id} before this session can message them.`,
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
  };
}

/**
 * Handle `/bus revoke`.
 *
 * @param bus - the bus service.
 * @param me - the calling agent.
 * @param address - the raw address argument.
 * @returns a command result.
 */
async function revoke(bus, me, address) {
  if (address === '') return { kind: 'error', text: `usage: /bus revoke <session>. Use: /bus ${USAGE}` };
  const resolved = await resolveForGrant(bus, me, address);
  if (resolved.error !== undefined) return { kind: 'error', text: resolved.error };
  const { peerId, peerRow, myRow } = resolved.context;
  const removed = await bus.allowlist.revoke(peerId, me.id);
  const stillByConfig = bus.isAllowedByConfig(peerRow, myRow);
  if (!removed) {
    return {
      kind: 'success',
      text: stillByConfig
        ? `${peerId} has no runtime grant. It may still message this session because the config allowlist permits it — remove that rule from the profile's cordis.patch.yml to stop it.`
        : `${peerId} had no runtime grant, and may not message this session.`,
    };
  }
  return {
    kind: 'success',
    text: stillByConfig
      ? `Runtime grant revoked, but the config allowlist still permits ${peerId} to message this session.`
      : `Revoked: ${peerId} may no longer message this session.`,
  };
}

/**
 * Handle `/bus list`.
 *
 * Reports the effective set — not just the runtime grants — because a user who
 * revokes something the config still permits needs to see that immediately.
 *
 * @param bus - the bus service.
 * @param me - the calling agent.
 * @returns a command result.
 */
async function list(bus, me) {
  const rows = await bus.roster();
  const myRow = rows.find((row) => row.id === me.id) ?? bus.rowOf(me);
  const lines = [];
  for (const row of rows) {
    if (row.id === me.id) continue;
    const byConfig = bus.isAllowedByConfig(row, myRow);
    const byRuntime = bus.allowlist.has(row.id, me.id);
    if (!byConfig && !byRuntime) continue;
    const source = byConfig && byRuntime ? 'config + runtime' : byConfig ? 'config' : 'runtime';
    lines.push(`  ${row.id}\t${source}${row.archived === true ? '\tarchived' : ''}`);
  }
  if (lines.length === 0) {
    return `No session may message ${me.id} yet.\nRun /bus allow <session> to let one in.`;
  }
  return [`Sessions that may message ${me.id}:`, ...lines].join('\n');
}

/**
 * Dispatch one `/bus` invocation.
 *
 * @param bus - the bus service.
 * @param invocation - the command invocation from the registry.
 * @returns a command result.
 */
async function run(bus, invocation) {
  const me = invocation.agent;
  const words = invocation.rawInput.trim().split(/\s+/).filter((word) => word !== '');
  const verb = (words.shift() ?? '').toLowerCase();
  const rest = words.join(' ');
  switch (verb) {
    case '':
    case 'help':
      return { kind: 'success', text: helpText(me) };
    case 'id':
      return { kind: 'success', text: `This session's id is ${me.id}` };
    case 'list':
      return { kind: 'success', text: await list(bus, me) };
    case 'allow':
      return await allow(bus, me, rest);
    case 'revoke':
      return await revoke(bus, me, rest);
    default:
      return { kind: 'error', text: `unknown /bus subcommand "${verb}". Use: /bus ${USAGE}` };
  }
}

/**
 * Register `/bus` for every composed command adapter.
 *
 * Registration is skipped, not faked, when this composition mounts no command
 * registry: the model tools do not depend on it, so a profile without one keeps a
 * working bus and simply has no human-facing allowlist editor.
 *
 * @param ctx - plugin context.
 * @param bus - the bus service the command edits.
 */
function registerBusCommands(ctx, bus) {
  const commands = ctx.get('commands');
  if (commands === undefined) return;
  ctx.effect(() =>
    commands.register({
      name: 'bus',
      description: 'Show or change who may send this session a peer-bus message',
      input: { hint: `[${USAGE}]` },
      handler: (invocation) => run(bus, invocation),
    }),
  );
}

export { helpText, registerBusCommands, run };
