import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);

/** Bodies shorter than this stay plain: gzip would barely shrink them. */
const MIN_GZIP_BYTES = 1024;

/** zlib level. Fulfillment inflates whatever level the node sends; this matches its own replies. */
const GZIP_LEVEL = 6;

/**
 * A result body ready to hand to `fetch`. The body is the original string when it is under
 * {@link MIN_GZIP_BYTES}, and gzip bytes otherwise.
 */
export interface GzipBodyResult {
  body: BodyInit;
  headers: Record<string, string>;
}

/**
 * Gzips a JSON result body for a fulfillment ingest that already unpacks `Content-Encoding: gzip`.
 * `fetch` does not compress a request body, so the caller sets the header itself.
 * @param json - The serialized result. Byte length is UTF-8, not `string.length`.
 * @param contentType - The existing `Content-Type` (`text/plain` or `application/json`).
 * @returns The body and headers to pass to `fetch`.
 */
export async function gzipBody(json: string, contentType: string): Promise<GzipBodyResult> {
  if (Buffer.byteLength(json) < MIN_GZIP_BYTES) {
    return { body: json, headers: { "Content-Type": contentType } };
  }
  const packed = await gzipAsync(json, { level: GZIP_LEVEL });
  // Copy into a fresh ArrayBuffer. Node's Buffer is a Uint8Array over ArrayBufferLike,
  // which Electron's fetch BodyInit does not accept.
  const bytes = new Uint8Array(packed.byteLength);
  bytes.set(packed);
  return {
    body: bytes,
    headers: { "Content-Type": contentType, "Content-Encoding": "gzip" },
  };
}
