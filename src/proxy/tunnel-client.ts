/**
 * Proxy tunnel client. The device dials out to the tunnel server over one
 * WebSocket and carries TCP streams for it; nothing listens on the device.
 *
 * Every OPEN is checked here before any socket is opened (destination-check,
 * mode "tls": port 443 only, public addresses only, after DNS), and the
 * socket goes to the exact address that was checked. The server's word is
 * never trusted for destination safety.
 *
 * Off unless the app enables the proxy and the user accepted the consent
 * text that mentions it (see index.ts).
 *
 * Device impact is capped: at most `maxStreams` streams, a daily byte budget
 * (counted on the device, kept across restarts), and the app can pause the
 * tunnel (on battery, before sleep); a paused tunnel stays closed until every
 * pause reason is cleared.
 */
import { EventEmitter } from 'events';
import net from 'net';
import WebSocket from 'isomorphic-ws';
import { checkHostPort, DestinationBlockedError, type Resolver } from '../net/destination-check';
import { CloseCode, decodeFrame, encodeFrame, encodeJson, FrameError, FrameType, PROTO_VERSION, SUBPROTOCOL } from './frames';
import { Mux, type OpenErrCode } from './mux';

export type PauseReason = 'battery' | 'sleep' | 'cap';

export interface ByteBudgetStore {
    load(): { day: string; bytes: number } | null;
    save(v: { day: string; bytes: number }): void;
}

export interface TunnelClientOptions {
    url: string;
    deviceId: string;
    /** The app's configuration key, sent in HELLO as `partner`. */
    partner?: string;
    /** Per-device secret (32 random bytes, base64url), generated once and stored with the SDK settings. */
    secret: string;
    sdk: string;
    platform: string;
    consentVersion: number;
    maxStreams?: number;
    connectTimeoutMs?: number;
    deadAfterMs?: number;
    livenessCheckMs?: number;
    backoffMinMs?: number;
    backoffMaxMs?: number;
    stableAfterMs?: number;
    /** Retry delay after the server said "not enabled" (4403). */
    notEnabledRetryMs?: number;
    /** Bytes per local day carried for the proxy (both directions). Default 1 GiB. */
    dailyByteCap?: number;
    /** Where the day's byte count is kept between app restarts. Default: memory only. */
    budget?: ByteBudgetStore;
    /** After GOAWAY, longest wait for open streams to finish before reconnecting. Default 30 s. */
    goawayMaxWaitMs?: number;
    /** Test seams for the local day. */
    today?: () => string;
    msUntilNextDay?: () => number;
    log?: (msg: string, data?: Record<string, unknown>) => void;
    /** Test seams. Production uses the system resolver and net.connect. */
    resolver?: Resolver;
    connect?: (o: { host: string; port: number; family: number }) => net.Socket;
}

export type TunnelState = 'idle' | 'connecting' | 'open' | 'waiting' | 'paused' | 'stopped';

const BUDGET_SAVE_EVERY = 1024 * 1024;

function localDay(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function msUntilLocalMidnight(): number {
    const d = new Date();
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 1);
    return next.getTime() - d.getTime();
}

/** Close codes after which reconnecting cannot help. */
const FINAL_CODES = new Set<number>([CloseCode.BAD_TOKEN, CloseCode.REPLACED, CloseCode.VERSION]);

export class TunnelClient extends EventEmitter {
    state: TunnelState = 'idle';
    private ws: WebSocket | null = null;
    private mux: Mux | null = null;
    private attempts = 0;
    private openedAt = 0;
    private lastFrame = 0;
    private draining = false;
    private retryTimer: NodeJS.Timeout | null = null;
    private livenessTimer: NodeJS.Timeout | null = null;
    private dayTimer: NodeJS.Timeout | null = null;
    private readonly pauses = new Set<PauseReason>();
    private used: { day: string; bytes: number };
    private lastSaved = 0;
    private readonly o: Required<Omit<TunnelClientOptions, 'resolver' | 'connect' | 'log' | 'partner' | 'budget'>> &
        Pick<TunnelClientOptions, 'resolver' | 'connect' | 'log' | 'partner' | 'budget'>;

    constructor(opts: TunnelClientOptions) {
        super();
        this.o = {
            maxStreams: 8,
            connectTimeoutMs: 8000,
            deadAfterMs: 45000,
            livenessCheckMs: 5000,
            backoffMinMs: 1000,
            backoffMaxMs: 60000,
            stableAfterMs: 60000,
            notEnabledRetryMs: 60 * 60 * 1000,
            dailyByteCap: 1024 * 1024 * 1024,
            goawayMaxWaitMs: 30000,
            today: localDay,
            msUntilNextDay: msUntilLocalMidnight,
            ...opts,
        };
        const stored = this.o.budget?.load();
        const today = this.o.today();
        this.used = stored && stored.day === today ? { day: today, bytes: stored.bytes } : { day: today, bytes: 0 };
        this.lastSaved = this.used.bytes;
    }

    start(): void {
        if (this.state === 'connecting' || this.state === 'open' || this.state === 'waiting') return;
        if (this.state === 'paused') return;
        this.rollDay();
        if (this.used.bytes >= this.o.dailyByteCap) this.capReached();
        if (this.pauses.size > 0) {
            this.state = 'paused';
            return;
        }
        this.connect();
    }

    /** Closes the tunnel (DRAIN with the reason first) and keeps it closed until resume() clears every reason. */
    pause(reason: PauseReason): void {
        this.pauses.add(reason);
        if (this.state === 'stopped' || this.state === 'paused') return;
        const wasIdle = this.state === 'idle';
        this.state = 'paused';
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.saveBudget();
        if (wasIdle) return;
        const ws = this.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(encodeJson(FrameType.DRAIN, 0, { reason }));
            this.mux?.closeAll('kill', true);
            ws.close(CloseCode.NORMAL, reason);
        } else {
            ws?.terminate();
        }
        this.log('tunnel paused', { reason });
    }

    resume(reason: PauseReason): void {
        this.pauses.delete(reason);
        if (this.state !== 'paused' || this.pauses.size > 0) return;
        this.state = 'idle';
        this.log('tunnel resumed', { reason });
        this.connect();
    }

    private rollDay(): void {
        const today = this.o.today();
        if (this.used.day !== today) {
            this.used = { day: today, bytes: 0 };
            this.lastSaved = 0;
        }
    }

    private capReached(): void {
        if (this.pauses.has('cap')) return;
        this.pauses.add('cap');
        if (this.dayTimer) clearTimeout(this.dayTimer);
        const wait = () => {
            this.dayTimer = setTimeout(() => {
                this.dayTimer = null;
                this.rollDay();
                if (this.used.bytes >= this.o.dailyByteCap) return wait(); // clock not past midnight yet
                this.saveBudget();
                this.resume('cap');
            }, Math.max(1000, this.o.msUntilNextDay()));
            this.dayTimer.unref?.();
        };
        wait();
    }

    /** Counts proxied bytes (DATA payloads, both directions) against the day's budget. */
    private count(n: number): void {
        this.rollDay();
        this.used.bytes += n;
        if (this.used.bytes - this.lastSaved >= BUDGET_SAVE_EVERY) this.saveBudget();
        if (this.used.bytes >= this.o.dailyByteCap && !this.pauses.has('cap')) {
            this.capReached();
            this.saveBudget();
            // Not from inside a frame handler or a send callback.
            setImmediate(() => {
                this.pauses.delete('cap');
                this.pause('cap');
            });
        }
    }

    private saveBudget(): void {
        if (!this.o.budget) return;
        this.o.budget.save({ day: this.used.day, bytes: this.used.bytes });
        this.lastSaved = this.used.bytes;
    }

    /** Opt-out closes every stream and the tunnel at once; shutdown does the same without the opt-out signal. */
    async stop(reason: 'optout' | 'shutdown'): Promise<void> {
        const wasRunning = this.state !== 'stopped' && this.state !== 'idle';
        this.state = 'stopped';
        this.clearTimers();
        this.saveBudget();
        const ws = this.ws;
        if (!ws || !wasRunning) return;
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(encodeJson(FrameType.DRAIN, 0, { reason }));
            this.mux?.closeAll('kill', true);
            await new Promise<void>((r) => {
                const t = setTimeout(() => { ws.terminate(); r(); }, 2000);
                ws.once('close', () => { clearTimeout(t); r(); });
                ws.close(CloseCode.NORMAL, reason);
            });
        } else {
            ws.terminate();
        }
        this.mux?.closeAll('kill');
        this.mux = null;
        this.ws = null;
    }

    private log(msg: string, data?: Record<string, unknown>) {
        this.o.log?.(msg, data);
    }

    private clearTimers() {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        if (this.livenessTimer) clearInterval(this.livenessTimer);
        if (this.dayTimer) clearTimeout(this.dayTimer);
        this.retryTimer = null;
        this.livenessTimer = null;
        this.dayTimer = null;
    }

    private connect(): void {
        this.state = 'connecting';
        this.draining = false;
        const ws = new WebSocket(this.o.url, SUBPROTOCOL, { handshakeTimeout: 15000 });
        this.ws = ws;
        ws.binaryType = 'nodebuffer';

        ws.on('open', () => {
            this.lastFrame = Date.now();
            ws.send(encodeJson(FrameType.HELLO, 0, {
                device_id: this.o.deviceId,
                token: this.o.secret,
                sdk: this.o.sdk,
                platform: this.o.platform,
                proto: PROTO_VERSION,
                max_streams: this.o.maxStreams,
                consent: this.o.consentVersion,
                ...(this.o.partner ? { partner: this.o.partner } : {}),
            }));
            this.livenessTimer = setInterval(() => {
                if (Date.now() - this.lastFrame > this.o.deadAfterMs) {
                    this.log('tunnel silent, reconnecting');
                    ws.terminate();
                }
            }, this.o.livenessCheckMs);
        });

        ws.on('message', (data: Buffer, isBinary: boolean) => {
            this.lastFrame = Date.now();
            if (!isBinary) return ws.close(CloseCode.PROTOCOL_ERROR, 'text frame');
            let d;
            try {
                d = decodeFrame(data);
            } catch (e) {
                this.log('bad frame from server', { code: e instanceof FrameError ? e.code : 'unknown' });
                return ws.close(CloseCode.PROTOCOL_ERROR, 'bad frame');
            }
            if (d.kind === 'ignored') return;
            if (d.kind === 'unknown_on_stream') return this.mux?.closeStream(d.streamId, 'error');
            switch (d.type) {
                case FrameType.HELLO_OK:
                    return this.onHelloOk(ws, d.json ?? {});
                case FrameType.PING:
                    return ws.send(encodeFrame(FrameType.PONG, 0, d.payload));
                case FrameType.PONG:
                    return;
                case FrameType.GOAWAY: {
                    const after = Math.max(0, Math.min(Number(d.json?.reconnect_after_ms ?? 0), 30000));
                    this.draining = true; // no new streams on this tunnel
                    this.log('server asked to reconnect', { reason: d.json?.reason, after });
                    // Open streams finish first (up to goawayMaxWaitMs), then the tunnel closes and reconnects.
                    const deadline = Date.now() + after + this.o.goawayMaxWaitMs;
                    const tryClose = () => {
                        if (ws.readyState !== WebSocket.OPEN) return;
                        if ((this.mux?.size ?? 0) === 0 || Date.now() >= deadline) return ws.close(CloseCode.NORMAL, 'goaway');
                        setTimeout(tryClose, 100);
                    };
                    setTimeout(tryClose, after);
                    return;
                }
                default:
                    if (d.type === FrameType.DATA) this.count(d.payload.length);
                    if (d.type >= 1 && d.type <= 6) this.mux?.handle(d);
            }
        });

        ws.on('close', (code: number) => {
            if (this.livenessTimer) clearInterval(this.livenessTimer);
            this.livenessTimer = null;
            this.mux?.closeAll('timeout');
            this.mux = null;
            if (this.ws === ws) this.ws = null;
            if (this.state === 'stopped' || this.state === 'paused') return;
            if (this.openedAt && Date.now() - this.openedAt >= this.o.stableAfterMs) this.attempts = 0;
            this.openedAt = 0;
            if (FINAL_CODES.has(code)) {
                this.log('tunnel refused, not reconnecting', { code });
                this.state = 'stopped';
                this.emit('stopped', code);
                return;
            }
            if (code === CloseCode.NOT_ENABLED) {
                this.state = 'waiting';
                this.retryTimer = setTimeout(() => this.connect(), this.o.notEnabledRetryMs);
                return;
            }
            this.state = 'waiting';
            this.retryTimer = setTimeout(() => this.connect(), this.backoff());
        });

        ws.on('error', (e: Error) => this.log('tunnel error', { message: e.message }));
    }

    private backoff(): number {
        const base = Math.min(this.o.backoffMaxMs, this.o.backoffMinMs * 2 ** this.attempts);
        this.attempts++;
        return Math.round(base * (0.8 + Math.random() * 0.4));
    }

    private onHelloOk(ws: WebSocket, ok: Record<string, unknown>): void {
        const mux = new Mux(
            (b) => {
                if (ws.readyState !== WebSocket.OPEN) return;
                if (b[0] === FrameType.DATA) this.count(b.length - 9);
                ws.send(b);
            },
            {
                initialWindow: Number(ok.initial_window ?? 262144),
                maxStreams: Math.min(this.o.maxStreams, Number(ok.max_streams ?? this.o.maxStreams)),
            },
            true,
        );
        mux.on('open-request', (id: number, host: string, port: number) => void this.onOpen(mux, id, host, port));
        this.mux = mux;
        this.state = 'open';
        this.openedAt = Date.now();
        this.emit('open');
        this.log('tunnel open', { tunnel: ok.tunnel_id });
    }

    private async onOpen(mux: Mux, id: number, host: string, port: number): Promise<void> {
        if (this.draining) return mux.reject(id, 'draining');
        let checked;
        try {
            checked = await checkHostPort(host, port, { mode: 'tls', resolver: this.o.resolver });
        } catch (e) {
            const code: OpenErrCode =
                e instanceof DestinationBlockedError && (e.reason === 'dns_failed' || e.reason === 'no_address') ? 'dns_failed' : 'target_blocked';
            return mux.reject(id, code);
        }
        if (this.mux !== mux) return;
        const sock = this.o.connect
            ? this.o.connect({ host: checked.address, port: checked.port, family: checked.family })
            : net.connect({ host: checked.address, port: checked.port, family: checked.family });
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            sock.destroy();
            mux.reject(id, 'connect_timeout');
        }, this.o.connectTimeoutMs);
        sock.once('connect', () => {
            if (settled) return sock.destroy();
            settled = true;
            clearTimeout(timer);
            const stream = mux.accept(id);
            sock.pipe(stream);
            stream.pipe(sock);
            stream.on('error', () => sock.destroy());
            stream.on('close', () => sock.destroy());
            sock.on('error', () => stream.close('error'));
        });
        sock.once('error', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            mux.reject(id, 'connect_failed');
        });
    }
}
