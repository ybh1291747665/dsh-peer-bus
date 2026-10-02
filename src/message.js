/**
 * The durable representation of one message this bus delivered.
 *
 * This lives apart from the bus itself because two modules need it: the bus, for
 * ordinary delivery, and the ask registry, which delivers a late answer to the
 * session that asked. Importing the bus from the registry would be a cycle.
 *
 * @module dsh-peer-bus/message
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/**
 * Durable attribution for one message this bus delivered between sessions.
 *
 * This is this package's own `MessageSourceMap` entry. `dsh-llm` declares that
 * map merge-extensible and states that each producer declares its kind in its own
 * module — there is deliberately no shared catch-all kind — and that consumers
 * fall through unknown kinds. A TypeScript consumer can extend the map with:
 *
 * ```ts
 * declare module '@deepseek-ai/dsh-llm' {
 *   interface MessageSourceMap {
 *     'peer-bus-message': {
 *       kind: 'peer-bus-message';
 *       form: 'relay';
 *       senderSessionId: SessionId;
 *       askId?: string;
 *     };
 *   }
 * }
 * ```
 */
const BUS_SOURCE_KIND = 'peer-bus-message';

/**
 * Whether a message source was produced by this bus.
 *
 * @param source - a message's `source` field, possibly absent.
 * @returns true when the bus produced it.
 */
const isBusSource = (source) => source?.kind === BUS_SOURCE_KIND;

/**
 * The model-visible lead-in for each kind of bus message.
 *
 * The lead-in is how the *receiving* model knows what it is looking at, and that
 * matters for a question: a real model run showed that when a `bus_ask` question
 * was framed like an ordinary message, the target answered in its turn **and**
 * sent the same answer back with `bus_send` — so the asker received it twice and
 * ran an extra turn for nothing. A question therefore says that the turn's reply
 * is returned automatically.
 */
const LEAD_INS = {
  message: (sender) => `Agent ${sender} sent a message: `,
  question: (sender) => `Agent ${sender} asked you a question: `,
  answer: (sender) => `Agent ${sender} answered your earlier question: `,
};

/** Closing note on a question, so the target answers once, in its turn. */
const QUESTION_NOTE =
  '\n\n(Answer in this turn: your reply is returned to the asker automatically, so do not also send it with bus_send.)';

/**
 * Matches any lead-in or the question note, so a reader that already frames the
 * message itself — `bus_wait`'s renderer — can strip them. Built from the same
 * table, so a new lead-in cannot silently leak into tool results.
 */
const FRAMING_BLOCK = new RegExp(
  `^(?:Agent \\S+ (?:${Object.values(LEAD_INS)
    .map((lead) => lead('\u0000').replace(/^Agent \u0000 /, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})|${QUESTION_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`,
);

/**
 * Build the durable, model-visible representation of one bus message.
 *
 * The source is this package's own `peer-bus-message` kind. Reusing
 * `dsh-subagent`'s `agent-message` kind would make bus traffic indistinguishable
 * from parent/child traffic in the transcript and in `bus_wait`.
 *
 * @param senderSessionId - session id credited as the author.
 * @param text - model-visible message body.
 * @param options - `askId` ties a `bus_ask` question or its late answer to the
 *   ask; `role` is `'question'` for the question itself and `'answer'` for a late
 *   answer delivered to the asker. Both default to an ordinary message.
 * @returns a frozen user message carrying that attribution.
 */
function createBusMessage(senderSessionId, text, { askId, role = 'message' } = {}) {
  const lead = (LEAD_INS[role] ?? LEAD_INS.message)(senderSessionId);
  return createUserMessage({
    content: [
      { type: 'text', text: lead },
      { type: 'text', text },
      ...(role === 'question' ? [{ type: 'text', text: QUESTION_NOTE }] : []),
    ],
    source: {
      kind: BUS_SOURCE_KIND,
      form: 'relay',
      senderSessionId,
      ...(askId === undefined ? {} : { askId }),
    },
  });
}

export { BUS_SOURCE_KIND, FRAMING_BLOCK, createBusMessage, isBusSource };
