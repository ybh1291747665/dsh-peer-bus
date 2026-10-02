/**
 * The wire format between two DSH processes.
 *
 * NDJSON: one JSON object per line. It is the format that needs the least
 * ceremony over a stream socket, and — more usefully — a malformed peer produces a
 * parse error on one line instead of corrupting a length-prefixed frame boundary.
 *
 * Every frame carries the protocol version, so a peer from a different build is
 * refused with a clear reason instead of being parsed into nonsense.
 *
 * @module dsh-peer-bus/xproc/protocol
 */
import { Buffer } from 'node:buffer';

/** Bumped when a frame's shape changes incompatibly. */
const PROTOCOL_VERSION = 1;

/**
 * Slack allowed on top of `maxMessageBytes` for one frame.
 *
 * A frame is the message body plus JSON escaping plus the envelope fields plus the
 * ask/receipt metadata, so the limit has to be the message limit plus headroom —
 * never the message limit itself, which would reject a legal maximum-size message.
 */
const FRAME_OVERHEAD_BYTES = 64 * 1024;

/** Hard ceiling on one frame, so a hostile peer cannot make us buffer forever. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * The frame size limit for one bus configuration.
 *
 * @param maxMessageBytes - the bus's own message limit.
 * @returns the byte budget for a single frame.
 */
const frameLimitFor = (maxMessageBytes) =>
  Math.min(MAX_FRAME_BYTES, Math.max(maxMessageBytes, 0) + FRAME_OVERHEAD_BYTES);

/**
 * Serialize one frame.
 *
 * Returns bytes rather than a string so that both ends of the wire agree on what a
 * frame is. A string here would be encoded again by `socket.write`, and any caller
 * that measured or split it would be slicing characters while the reader counts
 * bytes — the exact mismatch this format's handling exists to avoid.
 *
 * @param frame - frame object.
 * @returns the bytes to write, including the trailing newline.
 */
const encodeFrame = (frame) => Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');

/**
 * A request frame.
 *
 * @param id - correlation id, unique per connection.
 * @param op - operation name.
 * @param payload - operation arguments.
 * @returns the frame.
 */
const request = (id, op, payload) => ({ v: PROTOCOL_VERSION, id, op, ...(payload === undefined ? {} : { payload }) });

/**
 * A success response.
 *
 * @param id - the request's correlation id.
 * @param result - operation result.
 * @returns the frame.
 */
const success = (id, result) => ({ v: PROTOCOL_VERSION, id, ok: true, result: result ?? null });

/**
 * A failure response.
 *
 * @param id - the request's correlation id.
 * @param code - stable machine discriminator.
 * @param message - human-readable account.
 * @returns the frame.
 */
const failure = (id, code, message) => ({ v: PROTOCOL_VERSION, id, ok: false, error: { code, message } });

/** The frame delimiter, as a byte. No UTF-8 multi-byte sequence contains 0x0A. */
const FRAME_DELIMITER = 0x0a;

/**
 * An incremental NDJSON frame reader.
 *
 * Fed raw chunks; calls `onFrame` per complete line and `onError` once if the peer
 * sends something unusable, after which the caller is expected to drop the
 * connection.
 *
 * **The buffer holds bytes, not a string, and that is load-bearing.** Decoding each
 * arriving chunk on its own splits any multi-byte character that straddles a chunk
 * boundary into replacement characters: a 30 KB write on macOS arrives as several
 * chunks, so a message near `maxMessageBytes` of Chinese text would be corrupted —
 * and so would a question and its answer, which travel the same way. Nothing is
 * decoded until a full line is in hand, and a line boundary can never fall inside a
 * character, because no UTF-8 continuation or lead byte is 0x0A.
 *
 * Buffering bytes also removes the old per-chunk `Buffer.byteLength` of the whole
 * accumulated string, which made every read proportional to everything read so far.
 */
class FrameReader {
  /**
   * @param options - frame limit and sinks.
   */
  constructor({ limit, onFrame, onError }) {
    this.limit = limit;
    this.onFrame = onFrame;
    this.onError = onError;
    /** Undecoded bytes of the frame currently being read. */
    this.buffer = Buffer.alloc(0);
    this.broken = false;
  }

  /**
   * Feed one chunk.
   *
   * @param chunk - bytes from the socket.
   */
  push(chunk) {
    if (this.broken) return;
    // Bytes are the contract; a string is accepted so a caller cannot silently get
    // character-counted behaviour by passing one.
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (bytes.length === 0) return;
    // Reuse the arriving buffer when nothing is pending, which is the common case for
    // a stream of small writes.
    this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);

    let newline = this.buffer.indexOf(FRAME_DELIMITER);
    while (newline !== -1) {
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      newline = this.buffer.indexOf(FRAME_DELIMITER);
      if (line.length > this.limit) {
        this.fail(`frame exceeds the ${this.limit}-byte limit`);
        return;
      }
      if (!this.accept(line)) return;
    }

    // Only an *incomplete* frame is bounded here. A chunk carrying many complete
    // frames of any total size is legitimate, and each one is dropped as it is read,
    // so memory stays bounded either way.
    if (this.buffer.length > this.limit) {
      this.fail(`frame exceeds the ${this.limit}-byte limit`);
    }
  }

  /**
   * Decode and dispatch one complete line.
   *
   * @param line - the frame's bytes, without the delimiter.
   * @returns whether reading may continue.
   */
  accept(line) {
    const text = line.toString('utf8');
    if (text.trim() === '') return true;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.fail('frame is not valid JSON');
      return false;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.fail('frame is not a JSON object');
      return false;
    }
    if (parsed.v !== PROTOCOL_VERSION) {
      this.fail(`unsupported protocol version ${JSON.stringify(parsed.v)}`);
      return false;
    }
    this.onFrame(parsed);
    return !this.broken;
  }

  /**
   * Report one protocol failure, once.
   *
   * @param message - what was wrong.
   */
  fail(message) {
    if (this.broken) return;
    this.broken = true;
    this.buffer = Buffer.alloc(0);
    this.onError(new Error(message));
  }
}

export {
  FRAME_OVERHEAD_BYTES,
  FrameReader,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
  failure,
  frameLimitFor,
  request,
  success,
};
