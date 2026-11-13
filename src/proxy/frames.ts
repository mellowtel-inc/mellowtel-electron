// Tunnel frame codec, protocol v1 (frame format and frame types).
// Shared byte-for-byte between the tunnel server and the device SDK (src/proxy/frames.ts).

export const FrameType = {
  OPEN: 1,
  OPEN_OK: 2,
  OPEN_ERR: 3,
  DATA: 4,
  WINDOW: 5,
  CLOSE: 6,
  PING: 7,
  PONG: 8,
  HELLO: 9,
  DRAIN: 10,
  HELLO_OK: 11,
  GOAWAY: 12,
} as const;

export const HEADER_BYTES = 9;
export const MAX_PAYLOAD = 65536;
export const DATA_CHUNK = 16384;
export const PROTO_VERSION = 1;
export const SUBPROTOCOL = 'mellowtel-tunnel.v1';

export const CloseCode = {
  NORMAL: 1000,
  PROTOCOL_ERROR: 4400,
  BAD_TOKEN: 4401,
  NOT_ENABLED: 4403,
  HELLO_TIMEOUT: 4408,
  REPLACED: 4409,
  VERSION: 4426,
} as const;

const STREAM_TYPES = new Set<number>([1, 2, 3, 4, 5, 6]);
const TUNNEL_TYPES = new Set<number>([7, 8, 9, 10, 11, 12]);
const JSON_TYPES = new Set<number>([1, 2, 3, 6, 9, 10, 11, 12]);

export type FrameErrorCode = 'frame_too_short' | 'length_mismatch' | 'frame_too_large' | 'bad_stream_id' | 'bad_payload';

export class FrameError extends Error {
  constructor(readonly code: FrameErrorCode) {
    super(code);
    this.name = 'FrameError';
  }
}

export type Decoded =
  | { kind: 'frame'; type: number; streamId: number; payload: Buffer; json?: Record<string, unknown> }
  | { kind: 'ignored' }
  | { kind: 'unknown_on_stream'; streamId: number };

export function encodeFrame(type: number, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new FrameError('frame_too_large');
  const out = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(streamId >>> 0, 1);
  out.writeUInt32BE(payload.length, 5);
  payload.copy(out, HEADER_BYTES);
  return out;
}

export function encodeJson(type: number, streamId: number, body: Record<string, unknown>): Buffer {
  return encodeFrame(type, streamId, Buffer.from(JSON.stringify(body), 'utf8'));
}

export function encodeWindow(streamId: number, credit: number): Buffer {
  const p = Buffer.allocUnsafe(4);
  p.writeUInt32BE(credit >>> 0, 0);
  return encodeFrame(FrameType.WINDOW, streamId, p);
}

export function decodeFrame(buf: Buffer): Decoded {
  if (buf.length < HEADER_BYTES) throw new FrameError('frame_too_short');
  const type = buf.readUInt8(0);
  const streamId = buf.readUInt32BE(1);
  const length = buf.readUInt32BE(5);
  if (length > MAX_PAYLOAD) throw new FrameError('frame_too_large');
  if (length !== buf.length - HEADER_BYTES) throw new FrameError('length_mismatch');
  const payload = buf.subarray(HEADER_BYTES);

  if (!STREAM_TYPES.has(type) && !TUNNEL_TYPES.has(type)) {
    return streamId === 0 ? { kind: 'ignored' } : { kind: 'unknown_on_stream', streamId };
  }
  if ((STREAM_TYPES.has(type) && streamId === 0) || (TUNNEL_TYPES.has(type) && streamId !== 0)) {
    throw new FrameError('bad_stream_id');
  }
  if (type === FrameType.WINDOW) {
    if (payload.length !== 4 || payload.readUInt32BE(0) === 0) throw new FrameError('bad_payload');
    return { kind: 'frame', type, streamId, payload };
  }
  if (type === FrameType.PING || type === FrameType.PONG) {
    if (payload.length !== 8) throw new FrameError('bad_payload');
    return { kind: 'frame', type, streamId, payload };
  }
  if (JSON_TYPES.has(type)) {
    let json: unknown;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch {
      throw new FrameError('bad_payload');
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new FrameError('bad_payload');
    const obj = json as Record<string, unknown>;
    if (type === FrameType.OPEN && (typeof obj.host !== 'string' || obj.host === '' || obj.port !== 443)) {
      throw new FrameError('bad_payload');
    }
    return { kind: 'frame', type, streamId, payload, json: obj };
  }
  return { kind: 'frame', type, streamId, payload };
}
