import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);

/** Bodies shorter than this stay plain: gzip would barely shrink them. */
export const MIN_GZIP_BYTES = 1024;

/** zlib level. Fulfillment inflates whatever level the node sends; this matches its own replies. */
const GZIP_LEVEL = 6;

/**
 * A result body ready to hand to `fetch`. The body is the original string when gzip is off or
 * the body is under {@link MIN_GZIP_BYTES}, and gzip bytes otherwise.
 */
export interface GzipBodyResult {
  body: BodyInit;
  headers: Record<string, string>;
  /** Whether `body` is gzip bytes. */
  gzipped: boolean;
  /** UTF-8 size of the original string. */
  rawBytes: number;
  /** Size of what goes on the wire. Equals `rawBytes` when not gzipped. */
  sentBytes: number;
}

/**
 * Prepares a JSON result body for POSTing, gzipping it only when the job opted in.
 * `fetch` does not compress a request body, so the caller sets the header itself.
 * @param json - The serialized result. Byte length is UTF-8, not `string.length`.
 * @param contentType - The existing `Content-Type` (`text/plain` or `application/json`).
 * @param enabled - The job's `gzipResponse` flag. When false the body and headers are exactly
 *   what was sent before gzip support existed.
 * @returns The body and headers to pass to `fetch`, plus sizes for logging.
 */
export async function gzipBody(json: string, contentType: string, enabled: boolean): Promise<GzipBodyResult> {
  const rawBytes = Buffer.byteLength(json);
  if (!enabled || rawBytes < MIN_GZIP_BYTES) {
    return { body: json, headers: { "Content-Type": contentType }, gzipped: false, rawBytes, sentBytes: rawBytes };
  }
  const packed = await gzipAsync(json, { level: GZIP_LEVEL });
  // Copy into a fresh ArrayBuffer. Node's Buffer is a Uint8Array over ArrayBufferLike,
  // which Electron's fetch BodyInit does not accept.
  const bytes = new Uint8Array(packed.byteLength);
  bytes.set(packed);
  return {
    body: bytes,
    headers: { "Content-Type": contentType, "Content-Encoding": "gzip" },
    gzipped: true,
    rawBytes,
    sentBytes: bytes.byteLength,
  };
}

/** One-line summary for logs, e.g. `gzip 52310 -> 8741 bytes` or `plain 812 bytes (gzip off)`. */
export function describeEncoding(encoded: GzipBodyResult, enabled: boolean): string {
  if (encoded.gzipped) {
    return `gzip ${encoded.rawBytes} -> ${encoded.sentBytes} bytes`;
  }
  return `plain ${encoded.rawBytes} bytes (${enabled ? "under gzip threshold" : "gzip off"})`;
}
