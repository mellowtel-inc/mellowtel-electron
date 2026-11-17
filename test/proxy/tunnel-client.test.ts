// Device tunnel client against a local test server that speaks the same protocol (frames + mux from src/proxy).
import { describe, expect, it } from 'vitest';
import net from 'net';
import { createHash, randomBytes } from 'crypto';
import { encodeFrame, encodeJson, FrameType } from '../../src/proxy/frames';
import { OpenError } from '../../src/proxy/mux';
import vectors from './fixtures/tunnel-frames.json';
import { cleanups, client, echoTarget, sleep, testServer, until } from './harness';

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

describe('stream slots', () => {
    // A site that closes first (Connection: close, idle timeout) must not leave the slot taken after the caller
    // hangs up; otherwise the device answers busy to everything once max_streams such requests have happened.
    for (const first of ['site', 'caller'] as const) {
        it(`slots are freed after each request when the ${first} closes first`, async () => {
            const site = net.createServer((s) => {
                s.on('error', () => undefined);
                s.once('data', () => {
                    s.write('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
                    if (first === 'site') s.end();
                });
            });
            await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
            cleanups.push(() => new Promise<void>((r) => site.close(() => r())));
            const srv = await testServer();
            cleanups.push(srv.close);
            const { c } = client(srv.url, {}, (site.address() as net.AddressInfo).port);
            c.start();
            await until(() => srv.state.mux !== null);
            for (let i = 0; i < 12; i++) {
                const { stream, opened } = srv.state.mux!.openStream('example.com', 443);
                await opened; // the 9th would be refused with busy if slots leaked
                stream.write('GET / HTTP/1.1\r\nhost: example.com\r\n\r\n');
                await new Promise<void>((r) => stream.once('data', () => r()));
                stream.end(); // the caller hung up
                await until(() => (c as unknown as { mux: { size: number } }).mux.size === 0, 2000);
            }
        });
    }
});
