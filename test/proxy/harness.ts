// Shared harness for the tunnel client tests: a minimal tunnel server, an echo target and a client factory.
import { afterEach } from 'vitest';
import net from 'net';
import { randomBytes } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { TunnelClient, type TunnelClientOptions } from '../../src/proxy/tunnel-client';
import { decodeFrame, encodeJson, FrameType, SUBPROTOCOL } from '../../src/proxy/frames';
import { Mux } from '../../src/proxy/mux';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(cond: () => boolean, ms = 3000) {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('condition not met in time');
        await sleep(10);
    }
}

/** Minimal tunnel server: accepts HELLO, can open streams, records frames, can close with a code. */
export async function testServer(opts: { closeWithAfterHello?: number } = {}) {
    const wss = new WebSocketServer({ port: 0, handleProtocols: (p) => (p.has(SUBPROTOCOL) ? SUBPROTOCOL : false) });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as net.AddressInfo).port;
    const state = { hellos: [] as Record<string, unknown>[], frames: [] as Array<{ type: number; json?: Record<string, unknown> }>, mux: null as Mux | null, ws: null as WebSocket | null };
    wss.on('connection', (ws) => {
        state.ws = ws;
        ws.on('message', (data: Buffer) => {
            const d = decodeFrame(data);
            if (d.kind !== 'frame') return;
            state.frames.push({ type: d.type, json: d.json });
            if (d.type === FrameType.HELLO) {
                state.hellos.push(d.json ?? {});
                if (opts.closeWithAfterHello) return ws.close(opts.closeWithAfterHello, 'test');
                state.mux = new Mux((b) => ws.send(b), { initialWindow: 262144, maxStreams: 8 });
                ws.send(encodeJson(FrameType.HELLO_OK, 0, { tunnel_id: 't-1', max_streams: 8, initial_window: 262144, ping_interval_s: 20 }));
                return;
            }
            if (d.type >= 1 && d.type <= 6) state.mux?.handle(d);
        });
    });
    return { port, url: `ws://127.0.0.1:${port}/v1/tunnel`, state, wss, close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }) };
}

/** Echo target standing in for the site; the device's connect seam sends every checked address here. */
export async function echoTarget() {
    // The error listener matters: a test that tears down a stalled stream leaves the echo mid-write (EPIPE).
    const srv = net.createServer((s) => { s.on('error', () => undefined); s.pipe(s); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    return { port: (srv.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

export const PUBLIC = [{ address: '93.184.215.14', family: 4 }];
export const cleanups: Array<() => unknown> = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
});

export function client(url: string, over: Partial<TunnelClientOptions> = {}, echoPort = 0) {
    const connected: Array<{ host: string; port: number }> = [];
    const c = new TunnelClient({
        url,
        deviceId: 'mllwtl_test_device',
        secret: randomBytes(32).toString('base64url'),
        sdk: '700.0.40',
        platform: 'electron-macos',
        consentVersion: 2,
        resolver: async (host) => (host === 'private.example' ? [{ address: '10.0.0.5', family: 4 }] : host === 'nxdomain.example' ? Promise.reject(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })) : PUBLIC),
        connect: (o) => {
            connected.push({ host: o.host, port: o.port });
            return net.connect(echoPort, '127.0.0.1');
        },
        backoffMinMs: 20,
        backoffMaxMs: 100,
        ...over,
    });
    cleanups.push(() => c.stop('shutdown'));
    return { c, connected };
}

