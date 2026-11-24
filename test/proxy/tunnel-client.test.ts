// Device tunnel client against a local test server that speaks the same protocol (frames + mux from src/proxy).
import { afterEach, describe, expect, it } from 'vitest';
import net from 'net';
import { createHash, randomBytes } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { TunnelClient, type TunnelClientOptions } from '../../src/proxy/tunnel-client';
import { decodeFrame, encodeFrame, encodeJson, FrameType, SUBPROTOCOL } from '../../src/proxy/frames';
import { Mux, OpenError } from '../../src/proxy/mux';
import vectors from './fixtures/tunnel-frames.json';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('condition not met in time');
        await sleep(10);
    }
}

/** Minimal tunnel server: accepts HELLO, can open streams, records frames, can close with a code. */
async function testServer(opts: { closeWithAfterHello?: number } = {}) {
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
async function echoTarget() {
    const srv = net.createServer((s) => s.pipe(s));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    return { port: (srv.address() as net.AddressInfo).port, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

const PUBLIC = [{ address: '93.184.215.14', family: 4 }];
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
});

function client(url: string, over: Partial<TunnelClientOptions> = {}, echoPort = 0) {
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

describe('frames (4.1-T1): shared vectors byte-exact', () => {
    for (const v of vectors.valid) {
        it(v.name, () => {
            const payload = 'json' in v.payload ? Buffer.from(JSON.stringify(v.payload.json)) : Buffer.from((v.payload as { hex: string }).hex, 'hex');
            expect(encodeFrame(v.type, v.stream_id, payload).toString('hex')).toBe(v.hex);
        });
    }
});

describe('tunnel client (4.1)', () => {
    it('sends HELLO with the device secret, SDK, platform and consent version', async () => {
        const srv = await testServer();
        cleanups.push(srv.close);
        const { c } = client(srv.url);
        c.start();
        await until(() => srv.state.hellos.length === 1);
        expect(srv.state.hellos[0]).toMatchObject({ device_id: 'mllwtl_test_device', sdk: '700.0.40', platform: 'electron-macos', proto: 1, consent: 2, max_streams: 8 });
        expect(String(srv.state.hellos[0].token)).toHaveLength(43);
        await until(() => c.state === 'open');
    });

    it('T2: OPEN → check → connect to the checked address → bytes both ways → CLOSE with counts', async () => {
        const srv = await testServer();
        const echo = await echoTarget();
        cleanups.push(srv.close, echo.close);
        const { c, connected } = client(srv.url, {}, echo.port);
        c.start();
        await until(() => c.state === 'open');
        const { opened } = srv.state.mux!.openStream('chatgpt.com', 443);
        const s = await opened;
        const payload = randomBytes(2 * 1024 * 1024);
        const got: Buffer[] = [];
        s.on('data', (b: Buffer) => got.push(b));
        s.write(payload);
        await until(() => Buffer.concat(got).length === payload.length, 5000);
        expect(createHash('sha256').update(Buffer.concat(got)).digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'));
        expect(connected).toEqual([{ host: '93.184.215.14', port: 443 }]);
        s.end();
        await until(() => s.peerRx !== null);
        expect([s.peerRx, s.peerTx]).toEqual([payload.length, payload.length]);
    });

    it('T3: private literal or name, and DNS failure → OPEN_ERR; no socket is opened', async () => {
        const srv = await testServer();
        cleanups.push(srv.close);
        const { c, connected } = client(srv.url);
        c.start();
        await until(() => c.state === 'open');
        const codes: string[] = [];
        for (const host of ['192.168.1.1', 'private.example', 'localhost', 'nxdomain.example']) {
            try {
                await srv.state.mux!.openStream(host, 443).opened;
                codes.push('opened');
            } catch (e) {
                codes.push((e as OpenError).code);
            }
        }
        expect(codes).toEqual(['target_blocked', 'target_blocked', 'target_blocked', 'dns_failed']);
        expect(connected).toEqual([]);
    });

    it('a target that never answers → OPEN_ERR connect_timeout', async () => {
        const srv = await testServer();
        cleanups.push(srv.close);
        const { c } = client(srv.url, { connectTimeoutMs: 150, connect: () => new net.Socket() });
        c.start();
        await until(() => c.state === 'open');
        await expect(srv.state.mux!.openStream('chatgpt.com', 443).opened).rejects.toMatchObject({ code: 'connect_timeout' });
    });

    it('T4: server goes away → the client reconnects and says HELLO again with the same secret', async () => {
        const srv = await testServer();
        cleanups.push(srv.close);
        const { c } = client(srv.url);
        c.start();
        await until(() => srv.state.hellos.length === 1);
        srv.state.ws!.terminate();
        await until(() => srv.state.hellos.length === 2, 3000);
        expect(srv.state.hellos[1].token).toBe(srv.state.hellos[0].token);
    });

    for (const [code, what] of [[4401, 'bad secret'], [4409, 'replaced'], [4426, 'unsupported version'], [4403, 'not enabled']] as const) {
        it(`close ${code} (${what}) → no reconnect`, async () => {
            const srv = await testServer({ closeWithAfterHello: code });
            cleanups.push(srv.close);
            const { c } = client(srv.url);
            c.start();
            await until(() => srv.state.hellos.length === 1);
            await sleep(400);
            expect(srv.state.hellos).toHaveLength(1);
            expect(c.state).toBe(code === 4403 ? 'waiting' : 'stopped');
        });
    }

    it('answers PING with PONG carrying the same bytes', async () => {
        const srv = await testServer();
        cleanups.push(srv.close);
        const { c } = client(srv.url);
        c.start();
        await until(() => c.state === 'open');
        const ping = Buffer.from('0102030405060708', 'hex');
        srv.state.ws!.send(encodeFrame(FrameType.PING, 0, ping));
        await until(() => srv.state.frames.some((f) => f.type === FrameType.PONG));
    });

    it('opt-out: DRAIN optout, open streams closed, tunnel closed, no reconnect', async () => {
        const srv = await testServer();
        const echo = await echoTarget();
        cleanups.push(srv.close, echo.close);
        const { c } = client(srv.url, {}, echo.port);
        c.start();
        await until(() => c.state === 'open');
        const s = await srv.state.mux!.openStream('chatgpt.com', 443).opened;
        const closed = new Promise<void>((r) => s.once('close', () => r()));
        const t0 = Date.now();
        await c.stop('optout');
        await closed;
        expect(Date.now() - t0).toBeLessThan(5000);
        expect(srv.state.frames.find((f) => f.type === FrameType.DRAIN)?.json).toEqual({ reason: 'optout' });
        await sleep(200);
        expect(srv.state.hellos).toHaveLength(1);
        expect(c.state).toBe('stopped');
    });

    it('GOAWAY → reconnects after the delay', async () => {
        const srv = await testServer();
        cleanups.push(srv.close);
        const { c } = client(srv.url);
        c.start();
        await until(() => c.state === 'open');
        srv.state.ws!.send(encodeJson(FrameType.GOAWAY, 0, { reason: 'deploy', reconnect_after_ms: 50 }));
        await until(() => srv.state.hellos.length === 2, 3000);
    });

    it('a tunnel that goes silent is dropped and re-established', async () => {
        const srv = await testServer();
        cleanups.push(srv.close);
        const { c } = client(srv.url, { deadAfterMs: 200, livenessCheckMs: 50 });
        c.start();
        await until(() => srv.state.hellos.length === 1);
        await until(() => srv.state.hellos.length === 2, 3000);
    });
});
