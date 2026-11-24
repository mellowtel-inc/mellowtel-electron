// Stream multiplexer over one tunnel, protocol v1 (streams and flow control).
// Used by both ends: the server opens streams, the device accepts them. Shared byte-for-byte between the
// tunnel server and the device SDK (src/proxy/mux.ts), so keep it free of runtime-specific APIs.
import { Duplex } from 'stream';
import { EventEmitter } from 'events';
import { DATA_CHUNK, encodeFrame, encodeJson, encodeWindow, FrameType } from './frames.js';

export type OpenErrCode = 'target_blocked' | 'dns_failed' | 'connect_failed' | 'connect_timeout' | 'busy' | 'draining';
export type CloseReason = 'normal' | 'error' | 'kill' | 'timeout';

export interface MuxOptions {
  /** Bytes each side may send per stream before it receives credit (both directions). */
  initialWindow: number;
  /** Most streams open at once on this tunnel. */
  maxStreams: number;
}

type StreamFrame = { type: number; streamId: number; payload: Buffer; json?: Record<string, unknown> };

export class TunnelStream extends Duplex {
  /** Bytes the peer has allowed us to send. */
  private sendCredit: number;
  /** Total credit granted back to the peer (WINDOW frames sent). Only bytes the reader consumed are credited,
   *  so at most one window is ever buffered here: rx - granted <= window. */
  private granted = 0;
  private pending: { chunk: Buffer; cb: (err?: Error | null) => void } | null = null;
  private sentClose = false;
  private gotClose = false;
  /** Payload bytes sent / received as DATA (the device reports these in its CLOSE). */
  tx = 0;
  rx = 0;
  closeReason: CloseReason | null = null;
  state: 'opening' | 'open' | 'closed' = 'opening';

  constructor(
    readonly id: number,
    private readonly mux: Mux,
    private readonly window: number,
  ) {
    super({ readableHighWaterMark: window, writableHighWaterMark: DATA_CHUNK, allowHalfOpen: false });
    this.sendCredit = window;
    // A stream can be torn down (tunnel lost, peer error) before anyone listens; never let that crash the process.
    this.on('error', () => undefined);
  }

  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (this.sentClose || this.gotClose) return cb(new Error('stream closed'));
    this.pending = { chunk, cb };
    this.flush();
  }

  /** Sends as much of the pending chunk as credit allows; completes its write when all of it is out. */
  private flush(): void {
    const p = this.pending;
    if (!p) return;
    while (p.chunk.length > 0 && this.sendCredit > 0) {
      const n = Math.min(p.chunk.length, DATA_CHUNK, this.sendCredit);
      this.mux.send(encodeFrame(FrameType.DATA, this.id, p.chunk.subarray(0, n)));
      this.sendCredit -= n;
      this.tx += n;
      p.chunk = p.chunk.subarray(n);
    }
    if (p.chunk.length === 0) {
      this.pending = null;
      p.cb();
    }
  }

  _read(): void {
    this.grant(false);
  }

  // Consumption is credited here, after the bytes have left the buffer. _read() alone is not enough: Node
  // calls it only once until the next push, and the peer pushes nothing until it gets credit.
  read(size?: number): any { // eslint-disable-line @typescript-eslint/no-explicit-any
    const out = super.read(size);
    this.grant(true);
    return out;
  }

  /** Credits the peer for bytes the reader has consumed (received minus still buffered). */
  private grant(onlyIfLarge: boolean): void {
    if (this.sentClose || this.gotClose) return;
    const n = this.rx - this.readableLength - this.granted;
    if (n <= 0) return;
    if (onlyIfLarge && n < this.window / 2 && this.readableLength > 0) return;
    this.mux.send(encodeWindow(this.id, n));
    this.granted += n;
  }

  _final(cb: (err?: Error | null) => void): void {
    this.sendClose('normal');
    cb();
  }

  _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    if (this.pending) {
      this.pending.cb(err ?? new Error('stream closed'));
      this.pending = null;
    }
    this.sendClose(err ? (this.closeReason ?? 'error') : 'normal');
    this.mux.forget(this);
    this.state = 'closed';
    cb(err);
  }

  /** Close with a reason (both directions). */
  close(reason: CloseReason = 'normal'): void {
    this.closeReason = reason;
    this.sendClose(reason);
    this.destroy();
  }

  private sendClose(reason: CloseReason): void {
    if (this.sentClose) return;
    this.sentClose = true;
    const body: Record<string, unknown> = { reason };
    if (this.mux.reportsCounts) {
      body.rx = this.rx;
      body.tx = this.tx;
    }
    this.mux.send(encodeJson(FrameType.CLOSE, this.id, body));
  }

  /** @internal frame from the peer */
  onFrame(f: StreamFrame): void {
    switch (f.type) {
      case FrameType.DATA: {
        if (this.state !== 'open' || this.gotClose) return;
        if (f.payload.length === 0) return;
        if (this.rx + f.payload.length - this.granted > this.window) {
          // Peer sent beyond the credit we gave: protocol violation for this stream.
          this.closeReason = 'error';
          this.destroy(new Error('flow control violation'));
          return;
        }
        this.rx += f.payload.length;
        this.push(Buffer.from(f.payload));
        this.grant(true);
        return;
      }
      case FrameType.WINDOW: {
        this.sendCredit += f.payload.readUInt32BE(0);
        this.flush();
        return;
      }
      case FrameType.CLOSE: {
        this.gotClose = true;
        const reason = (f.json?.reason as CloseReason | undefined) ?? 'normal';
        if (!this.closeReason) this.closeReason = reason;
        if (typeof f.json?.rx === 'number') this.peerRx = f.json.rx as number;
        if (typeof f.json?.tx === 'number') this.peerTx = f.json.tx as number;
        this.sendClose(this.closeReason);
        if (reason === 'normal') {
          // Let the reader drain what is buffered; the stream ends (and is forgotten) after that.
          this.push(null);
          if (this.readableLength === 0 && this.readableEnded) this.destroy();
        } else {
          this.destroy(new Error(`closed by peer: ${reason}`));
        }
        return;
      }
    }
  }

  /** Counts the peer reported in its CLOSE (device → broker). */
  peerRx: number | null = null;
  peerTx: number | null = null;

  /** @internal */
  markOpen(): void {
    this.state = 'open';
  }
}

/**
 * Broker side: openStream() sends OPEN and resolves on OPEN_OK.
 * Device side: emits 'open-request' (id, host, port); answer with accept(id) or reject(id, code).
 */
export class Mux extends EventEmitter {
  private readonly streams = new Map<number, TunnelStream>();
  private readonly waiting = new Map<number, { resolve: (s: TunnelStream) => void; reject: (e: OpenError) => void }>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly sendFn: (buf: Buffer) => void,
    readonly opts: MuxOptions,
    /** Device side reports rx/tx in CLOSE. */
    readonly reportsCounts = false,
  ) {
    super();
  }

  get size(): number {
    return this.streams.size;
  }

  /** @internal */
  send(buf: Buffer): void {
    if (!this.closed) this.sendFn(buf);
  }

  /** @internal */
  forget(s: TunnelStream): void {
    if (this.streams.get(s.id) === s) this.streams.delete(s.id);
    const w = this.waiting.get(s.id);
    if (w) {
      this.waiting.delete(s.id);
      w.reject(new OpenError('connect_failed'));
    }
  }

  /** Broker: open a stream to host:port on this device. */
  openStream(host: string, port: number): { stream: TunnelStream; opened: Promise<TunnelStream> } {
    const id = this.nextId++;
    const stream = new TunnelStream(id, this, this.opts.initialWindow);
    this.streams.set(id, stream);
    const opened = new Promise<TunnelStream>((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    opened.catch(() => undefined);
    this.send(encodeJson(FrameType.OPEN, id, { host, port }));
    return { stream, opened };
  }

  /** Device: accept a requested stream after the destination check and TCP connect succeeded. */
  accept(id: number): TunnelStream {
    const stream = new TunnelStream(id, this, this.opts.initialWindow);
    stream.markOpen();
    this.streams.set(id, stream);
    this.send(encodeJson(FrameType.OPEN_OK, id, {}));
    return stream;
  }

  /** Device: refuse a requested stream. */
  reject(id: number, code: OpenErrCode): void {
    this.send(encodeJson(FrameType.OPEN_ERR, id, { code }));
  }

  /** Feed a decoded stream frame (types 1–6) from the peer. */
  handle(f: StreamFrame): void {
    if (f.type === FrameType.OPEN) {
      const host = f.json?.host as string;
      const port = f.json?.port as number;
      if (this.streams.has(f.streamId)) return;
      if (this.streams.size >= this.opts.maxStreams) return this.reject(f.streamId, 'busy');
      this.emit('open-request', f.streamId, host, port);
      return;
    }
    if (f.type === FrameType.OPEN_OK || f.type === FrameType.OPEN_ERR) {
      const w = this.waiting.get(f.streamId);
      const s = this.streams.get(f.streamId);
      if (!w || !s) return;
      this.waiting.delete(f.streamId);
      if (f.type === FrameType.OPEN_OK) {
        s.markOpen();
        w.resolve(s);
      } else {
        const code = (f.json?.code as OpenErrCode | undefined) ?? 'connect_failed';
        this.streams.delete(f.streamId);
        w.reject(new OpenError(code));
        s.destroy();
      }
      return;
    }
    const s = this.streams.get(f.streamId);
    if (s) s.onFrame(f);
  }

  /** Peer asked to close an unknown-type stream (forward compatibility). */
  closeStream(id: number, reason: CloseReason): void {
    const s = this.streams.get(id);
    if (s) s.close(reason);
    else this.send(encodeJson(FrameType.CLOSE, id, { reason }));
  }

  /** Tunnel gone or killed: close every stream locally. */
  closeAll(reason: CloseReason, notifyPeer = false): void {
    for (const s of [...this.streams.values()]) {
      s.closeReason = reason;
      if (notifyPeer) s.close(reason);
      else s.destroy(new Error(`tunnel ${reason}`));
    }
    for (const [id, w] of this.waiting) {
      this.waiting.delete(id);
      w.reject(new OpenError(reason === 'timeout' ? 'connect_timeout' : 'connect_failed'));
    }
    if (!notifyPeer) this.closed = true;
  }
}

export class OpenError extends Error {
  constructor(readonly code: OpenErrCode) {
    super(code);
    this.name = 'OpenError';
  }
}
