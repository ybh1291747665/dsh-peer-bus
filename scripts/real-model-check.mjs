/**
 * Real-model, real-machine check: two independent sessions on a real model route
 * use the bus to get work done, and the full transcript is kept as evidence.
 *
 * Unlike `e2e-bus.mjs` there is no scripted adapter here. The prompts are plain
 * task requests that never name a bus tool, so what the model reached for is an
 * observation, not a given. Two kinds of result are reported:
 *
 *   check    — a mechanism the bus guarantees (delivery, attribution, cold resume
 *              on a real route, receipts). A failure is a bug.
 *   observe  — a choice the model made (which tool it used). Reported, not failed:
 *              a model is free to solve the task another way.
 *
 * Isolation: like every script here it runs in the throwaway test home
 * (`scripts/dsh-home.mjs`), on the web profile without binding a port. Your real
 * `~/.dsh` is only READ, for two things, both at runtime and neither written into
 * this repository:
 *
 *   - the `llm-pi-ai` and `agent-default-model` rows of your web profile patch,
 *     copied into a gitignored overlay under `.dsh-test/`, so the run uses your
 *     configured provider and model;
 *   - the API key those rows name (`apiKeyEnv`), loaded into this process's own
 *     environment from `~/.dsh/.credentials.yaml` when it is not already exported.
 *     It is never printed or written anywhere.
 *
 * This spends real tokens. Usage:
 *
 *   node scripts/real-model-check.mjs
 *
 * Overrides: REAL_MODEL_SOURCE_PATCH (profile patch to read the model rows from),
 * REAL_MODEL_CREDENTIALS (credentials file), REAL_MODEL_PROVIDER / REAL_MODEL_MODEL
 * / REAL_MODEL_EFFORT (route), REAL_MODEL_OUT (transcript path).
 *
 * @module scripts/real-model-check
 */
import './dsh-home.mjs';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { runProfile } from '@deepseek-ai/dsh/profile-boot';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
// js-yaml ships with DSH; resolve it from there rather than adding a dependency.
const yaml = createRequire(join(repo, 'node_modules/@deepseek-ai/dsh/package.json'))('js-yaml');

const SOURCE_PATCH =
  process.env.REAL_MODEL_SOURCE_PATCH ?? join(homedir(), '.dsh/profiles/web/cordis.patch.yml');
const CREDENTIALS = process.env.REAL_MODEL_CREDENTIALS ?? join(homedir(), '.dsh/.credentials.yaml');
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const SCENARIO_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Model route: copy only the model rows out of the real profile.
// ---------------------------------------------------------------------------
const sourceRows = yaml.load(readFileSync(SOURCE_PATCH, 'utf8')) ?? [];
const llmRow = sourceRows.find((row) => row?.id === 'llm-pi-ai');
const defaultModelRow = sourceRows.find((row) => row?.id === 'agent-default-model');
if (llmRow === undefined || defaultModelRow === undefined) {
  console.error(`real-model-check: ${SOURCE_PATCH} has no llm-pi-ai / agent-default-model rows to copy`);
  process.exit(2);
}
const PROVIDER = process.env.REAL_MODEL_PROVIDER ?? defaultModelRow.config.provider;
const MODEL = process.env.REAL_MODEL_MODEL ?? defaultModelRow.config.model;
const EFFORT = process.env.REAL_MODEL_EFFORT ?? 'low';

// The key the provider row names, loaded only into this process.
const keyName = llmRow.config?.providers?.[PROVIDER]?.apiKeyEnv;
if (typeof keyName === 'string' && process.env[keyName] === undefined) {
  try {
    const stored = yaml.load(readFileSync(CREDENTIALS, 'utf8'))?.refs?.[keyName];
    if (typeof stored === 'string' && stored !== '') process.env[keyName] = stored;
  } catch {
    // Reported below as a missing key rather than as a parse error.
  }
}
if (typeof keyName === 'string' && process.env[keyName] === undefined) {
  console.error(`real-model-check: ${keyName} is neither exported nor stored in ${CREDENTIALS}`);
  process.exit(2);
}

const overlay = join(process.env.DSH_HOME, 'real-model.patch.yml');
writeFileSync(
  overlay,
  yaml.dump([
    llmRow,
    defaultModelRow,
    // The web profile mounts the bus through its bundle layer; this row only sets
    // the allowlist. A patch replaces the row's whole config, so unspecified keys
    // fall back to the schema defaults — which is what a real deployment gets.
    { id: 'peer-bus', config: { allow: [{ sameWorkspace: true }] } },
  ]),
);

// ---------------------------------------------------------------------------
// A real workspace for the worker to read from.
// ---------------------------------------------------------------------------
const workspace = mkdtempSync(join(tmpdir(), 'peer-bus-real-'));
writeFileSync(
  join(workspace, 'release.json'),
  `${JSON.stringify({ version: '4.2.0-rc.7', codename: 'blue-heron', frozen: false }, null, 2)}\n`,
);

const environment = createLaunchEnvironmentSnapshot([
  {
    source: 'process',
    values: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')),
  },
]);
const { ctx, shutdown } = await runProfile({
  environment,
  profile: 'web',
  patchFiles: [join(repo, 'web-noserver.patch.yml'), overlay],
  args: ['--no-open'],
});

const results = [];
const record = (kind, label, ok, detail = '') => {
  results.push({ kind, label, ok, detail });
  const tag = kind === 'check' ? (ok ? 'PASS ' : 'FAIL ') : ok ? 'SEEN ' : 'NOTE ';
  console.log(`  ${tag} ${label}${detail ? ` — ${detail}` : ''}`);
};
const check = (label, ok, detail) => record('check', label, ok, detail);
const observe = (label, ok, detail) => record('observe', label, ok, detail);

const agents = ctx.get('agents');
const bus = ctx.get('peerBus');
const presets = ctx.get('agentPresets');
const seen = new Map();
ctx.on('session/event', (session, event) => {
  const rows = seen.get(session.id) ?? [];
  rows.push(event);
  seen.set(session.id, rows);
});
const eventsOf = (id) => seen.get(id) ?? [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Compose a session the way the GUI does: the default preset, on the real route. */
async function createSession(name) {
  const presetId = presets === undefined ? undefined : (await presets.resolve()).id;
  return agents.create({
    sessionId: `session-real-${name}-${RUN}`,
    meta: { cwd: workspace, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
    agentOptions: { provider: PROVIDER, model: MODEL, reasoningEffort: EFFORT },
    // DSH calls `.commit()` on whatever setup returns, so return nothing: the
    // mount's own return value is not a commit handle.
    setup:
      presetId === undefined
        ? undefined
        : async (agentCtx) => {
            await presets.mount(agentCtx, presetId);
          },
  });
}

/** Wait for every given agent to go idle and stay idle, or give up. */
async function settle(sessionIds, ms = SCENARIO_TIMEOUT_MS) {
  const deadline = Date.now() + ms;
  let quietSince;
  while (Date.now() < deadline) {
    const busy = sessionIds.some((id) => agents.get(id)?.status === 'running' || agents.get(id)?.inbox?.hasPending);
    if (busy) quietSince = undefined;
    else if (quietSince === undefined) quietSince = Date.now();
    else if (Date.now() - quietSince > 3000) return true;
    await sleep(250);
  }
  return false;
}

const userPrompt = (text) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const textOf = (content) =>
  (content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('');
const toolCalls = (id, since = 0) =>
  eventsOf(id).slice(since).filter((event) => event.type === 'tool/call').map((event) => event.data.name);
const assistantText = (id, since = 0) =>
  eventsOf(id)
    .slice(since)
    .filter((event) => event.type === 'assistant/message')
    .map((event) => textOf(event.data.message.content))
    .join('\n');
const busArrivals = (id, since = 0) =>
  eventsOf(id)
    .slice(since)
    .filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'peer-bus-message');

console.log(`real-model-check: ${PROVIDER}/${MODEL} (effort ${EFFORT}), workspace ${workspace}`);
check('the bus is mounted on the web profile', bus !== undefined);

const plannerHandle = await createSession('planner');
let workerHandle = await createSession('worker');
const planner = plannerHandle.agent;
const workerId = workerHandle.agent.id;
const titles = ctx.get('sessionTitle');
titles?.rename(planner.session, 'Release Planner');
titles?.rename(workerHandle.agent.session, 'Release Worker');

// ---------------------------------------------------------------------------
console.log('\nscenario 1: a live peer answers a question about its workspace');
const mark1 = { planner: eventsOf(planner.id).length, worker: eventsOf(workerId).length };
planner.followup(
  userPrompt(
    `Another session in this project, titled "Release Worker" (session id ${workerId}), owns the release files. ` +
      'Find out from that session which version string release.json declares, then tell me the version. ' +
      'Get the answer from that session rather than reading the file yourself.',
  ),
);
check('scenario 1 settled', await settle([planner.id, workerId]));
const calls1 = toolCalls(planner.id, mark1.planner);
observe('planner used a bus tool to reach the worker', calls1.some((name) => name.startsWith('bus_')), calls1.join(', '));
observe('planner chose bus_ask (answer in its own tool result)', calls1.includes('bus_ask'), calls1.join(', '));
const arrivals1 = busArrivals(workerId, mark1.worker);
check('the worker received the question as a bus message', arrivals1.length >= 1);
check(
  'the question is credited to the planner',
  arrivals1.some((event) => event.data.source.senderSessionId === planner.id),
);
const workerCalls1 = toolCalls(workerId, mark1.worker);
observe('the worker used a tool to answer (e.g. read the file)', workerCalls1.length > 0, workerCalls1.join(', '));
// A question tells the target its turn reply goes back automatically; re-sending
// the answer with bus_send would deliver it twice and cost the asker a turn.
observe(
  'the worker answered once, without re-sending the answer via bus_send',
  !workerCalls1.includes('bus_send'),
  workerCalls1.join(', '),
);
check(
  'the planner reported the real version',
  assistantText(planner.id, mark1.planner).includes('4.2.0-rc.7'),
  assistantText(planner.id, mark1.planner).slice(-200).replace(/\s+/g, ' '),
);

// ---------------------------------------------------------------------------
console.log('\nscenario 2: a stored peer is cold-resumed on its real route and answers');
await workerHandle.dispose();
check('the worker is unloaded', agents.get(workerId) === undefined);
const mark2 = { planner: eventsOf(planner.id).length, worker: eventsOf(workerId).length };
planner.followup(
  userPrompt(
    'Ask the "Release Worker" session again: what codename does release.json give this release? ' +
      'Report the codename it gives you.',
  ),
);
check('scenario 2 settled', await settle([planner.id, workerId]));
check('the worker was resumed', agents.get(workerId) !== undefined);
const resumedModel = eventsOf(workerId)
  .slice(mark2.worker)
  .filter((event) => event.type === 'assistant/message')
  .map((event) => `${event.data.message.source?.provider}/${event.data.message.source?.model}`);
check(
  'the resumed worker ran real model turns on its recorded route',
  resumedModel.length > 0 && resumedModel.every((route) => route === `${PROVIDER}/${MODEL}`),
  resumedModel.join(', '),
);
check(
  'the planner reported the codename from the resumed worker',
  assistantText(planner.id, mark2.planner).toLowerCase().includes('blue-heron'),
  assistantText(planner.id, mark2.planner).slice(-200).replace(/\s+/g, ' '),
);
const workerCalls2 = toolCalls(workerId, mark2.worker);
observe(
  'the resumed worker answered once, without re-sending via bus_send',
  !workerCalls2.includes('bus_send'),
  workerCalls2.join(', ') || '(no tool calls)',
);

// ---------------------------------------------------------------------------
console.log('\nscenario 3: a one-way notice, and whether its delivery can be confirmed');
const mark3 = { planner: eventsOf(planner.id).length, worker: eventsOf(workerId).length };
planner.followup(
  userPrompt(
    'Tell the "Release Worker" session that the release is now frozen and it must not change release.json. ' +
      'It does not need to reply. Then confirm for me that your notice was actually picked up by that session.',
  ),
);
check('scenario 3 settled', await settle([planner.id, workerId]));
const calls3 = toolCalls(planner.id, mark3.planner);
observe('planner sent a one-way notice with bus_send', calls3.includes('bus_send'), calls3.join(', '));
observe('planner checked delivery with bus_status', calls3.includes('bus_status'), calls3.join(', '));
const notices = [...bus.receipts.receipts.values()].filter(
  (receipt) => receipt.from === planner.id && receipt.to === workerId,
);
check(
  'every planner→worker message has a settled receipt',
  notices.length > 0 && notices.every((receipt) => receipt.status === 'claimed' || receipt.status === 'received'),
  notices.map((receipt) => receipt.status).join(', '),
);
check('the worker received the notice', busArrivals(workerId, mark3.worker).length >= 1);

// ---------------------------------------------------------------------------
// Evidence: the full transcript of both sessions, as the models saw it.
// ---------------------------------------------------------------------------
function transcript(id, name) {
  const lines = [`### ${name} (\`${id}\`)`, ''];
  for (const event of eventsOf(id)) {
    if (event.type === 'user/message') {
      const kind = event.data?.source?.kind;
      if (kind !== 'user' && kind !== 'peer-bus-message') continue;
      lines.push(`**${kind === 'user' ? 'user' : 'bus message'}**: ${textOf(event.data.content)}`, '');
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data.message.content);
      if (text.trim() !== '') lines.push(`**assistant** (turn ${event.data.turn}): ${text.trim()}`, '');
    } else if (event.type === 'tool/call') {
      lines.push(`**tool call** \`${event.data.name}\` ${event.data.arguments}`, '');
    } else if (event.type === 'tool/result') {
      const text = textOf(event.data.message?.content).replace(/\s+/g, ' ');
      lines.push(`**tool result**: ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`, '');
    }
  }
  return lines.join('\n');
}

const failed = results.filter((result) => result.kind === 'check' && !result.ok);
const date = new Date().toISOString().slice(0, 10);
const out = process.env.REAL_MODEL_OUT ?? join(repo, 'verification', `real-model-${date}.md`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  [
    `# Real-model verification — ${date}`,
    '',
    `- Route: \`${PROVIDER}/${MODEL}\`, reasoning effort \`${EFFORT}\``,
    '- Profile: `web` (host resume path), isolated test home, no port bound',
    `- DSH: \`${createRequire(join(repo, 'node_modules/@deepseek-ai/dsh/package.json'))('./package.json').version}\``,
    '- Prompts are plain task requests; none names a bus tool.',
    `- Result: ${failed.length === 0 ? 'all mechanism checks passed' : `${failed.length} mechanism check(s) FAILED`}`,
    '',
    '| Kind | Result | Label | Detail |',
    '|---|---|---|---|',
    ...results.map(
      (result) =>
        `| ${result.kind} | ${result.kind === 'check' ? (result.ok ? 'PASS' : 'FAIL') : result.ok ? 'seen' : 'not seen'} | ${result.label} | ${String(result.detail).replace(/\|/g, '\\|').slice(0, 160)} |`,
    ),
    '',
    '## Transcript',
    '',
    transcript(planner.id, 'Release Planner'),
    transcript(workerId, 'Release Worker'),
  ].join('\n'),
);
console.log(`\ntranscript: ${out}`);
console.log(failed.length === 0 ? 'real-model-check OK' : `real-model-check FAILED (${failed.length})`);
await shutdown?.shutdown?.(failed.length === 0 ? 0 : 1);
process.exit(failed.length === 0 ? 0 : 1);
