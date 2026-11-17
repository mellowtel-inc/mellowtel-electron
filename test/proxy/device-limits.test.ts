// Device-side limits of the tunnel client: partner in HELLO, pause on battery / sleep, daily byte cap, opt-out
// speed, GOAWAY letting open streams finish, and one slow stream not holding up another.
import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { FrameType, encodeJson } from '../../src/proxy/frames';
import type { TunnelStream } from '../../src/proxy/mux';
import { cleanups, client, echoTarget, sleep, testServer, until } from './harness';

const drains = (srv: Awaited<ReturnType<typeof testServer>>) => srv.state.frames.filter((f) => f.type === FrameType.DRAIN).map((f) => f.json?.reason);

async function openEcho(srv: Awaited<ReturnType<typeof testServer>>): Promise<TunnelStream> {
    return srv.state.mux!.openStream('chatgpt.com', 443).opened;
}
async function roundTrip(s: TunnelStream, n: number): Promise<void> {
    let got = 0;
    const done = new Promise<void>((r) => s.on('data', (b: Buffer) => { got += b.length; if (got >= n) r(); }));
    s.write(randomBytes(n));
    await done;
}

describe('HELLO partner', () => {
    it('sends the partner key when given, and nothing when not', async () => {
        const srv = await testServer();
        cleanups.push(srv.close);
        const a = client(srv.url, { partner: 'app-key-1' }).c;
        a.start();
        await until(() => srv.state.hellos.length === 1);
        expect(srv.state.hellos[0]).toMatchObject({ partner: 'app-key-1' });
        await a.stop('shutdown');
        const b = client(srv.url).c;
        b.start();
        await until(() => srv.state.hellos.length === 2);
        expect(srv.state.hellos[1]).not.toHaveProperty('partner');
    });
});

describe('pause on battery and sleep', () => {
    it('battery: DRAIN battery, tunnel closed, no reconnect while paused; mains power → reconnects', async () => {
        const srv = await testServer();
        cleanups.push(srv.close);
        const { c } = client(srv.url);
        c.start();
        await until(() => c.state === 'open');
        c.pause('battery');
        expect(c.state).toBe('paused');
        await until(() => drains(srv).length === 1);
        expect(drains(srv)).toEqual(['battery']);
        await sleep(300); // well past the 20–100 ms test backoff
        expect(srv.state.hellos).toHaveLength(1);
        c.resume('battery');
        await until(() => c.state === 'open');
        expect(srv.state.hellos).toHaveLength(2);
    });

    it('two reasons: stays paused until both are cleared', async () => {
        const srv = await testServer();
        cleanups.push(srv.close);
        const { c } = client(srv.url);
        c.start();
        await until(() => c.state === 'open');
        c.pause('battery');
        c.pause('sleep');
        await until(() => c.state === 'paused');
        c.resume('sleep');
        await sleep(200);
        expect(c.state).toBe('paused');
        c.resume('battery');
        await until(() => c.state === 'open');
    });

    it('paused before start (app launched on battery): start does not connect until resumed', async () => {
        const srv = await testServer();
        cleanups.push(srv.close);
        const { c } = client(srv.url);
        c.pause('battery');
        c.start();
        await sleep(200);
        expect(srv.state.hellos).toHaveLength(0);
        c.resume('battery');
        await until(() => c.state === 'open');
    });

    it('sleep with a stream open: the stream is closed with the tunnel (the machine is about to suspend)', async () => {
        const srv = await testServer();
        const echo = await echoTarget();
        cleanups.push(srv.close, echo.close);
        const { c } = client(srv.url, {}, echo.port);
        c.start();
        await until(() => c.state === 'open');
        const s = await openEcho(srv);
        const closed = new Promise<void>((r) => s.once('close', () => r()));
        c.pause('sleep');
        await closed;
        expect(drains(srv)).toEqual(['sleep']);
    });
});

describe('daily byte cap', () => {
    it('cap reached → DRAIN cap and pause; the count survives a restart; a new day → reconnects', async () => {
        const srv = await testServer();
        const echo = await echoTarget();
        cleanups.push(srv.close, echo.close);
        const saved: { value: { day: string; bytes: number } | null } = { value: null };
        let day = '2026-11-16';
        const budget = { load: () => saved.value, save: (v: { day: string; bytes: number }) => (saved.value = v) };
        const { c } = client(srv.url, { dailyByteCap: 300_000, budget, today: () => day, msUntilNextDay: () => 60_000 }, echo.port);
        c.start();
        await until(() => c.state === 'open');
        const s = await openEcho(srv);
        await roundTrip(s, 200_000); // 200 KB up + 200 KB down = 400 KB > 300 KB
        await until(() => c.state === 'paused');
        expect(drains(srv)).toContain('cap');
        expect(saved.value!.day).toBe('2026-11-16');
        expect(saved.value!.bytes).toBeGreaterThanOrEqual(300_000);
        await c.stop('shutdown');

        // App restarted the same day: still over the cap, does not connect.
        const hellos = srv.state.hellos.length;
        const second = client(srv.url, { dailyByteCap: 300_000, budget, today: () => day, msUntilNextDay: () => 100 }, echo.port).c;
        second.start();
        await sleep(50);
        expect(second.state).toBe('paused');
        expect(srv.state.hellos).toHaveLength(hellos);
        // Midnight passes.
        day = '2026-11-17';
        await until(() => second.state === 'open', 3000);
        expect(srv.state.hellos).toHaveLength(hellos + 1);
    });

    it('under the cap nothing changes, and the count is saved for later', async () => {
        const srv = await testServer();
        const echo = await echoTarget();
        cleanups.push(srv.close, echo.close);
        const saved: { value: { day: string; bytes: number } | null } = { value: null };
        const { c } = client(srv.url, { dailyByteCap: 10_000_000, budget: { load: () => saved.value, save: (v) => (saved.value = v) }, today: () => '2026-11-16' }, echo.port);
        c.start();
        await until(() => c.state === 'open');
        const s = await openEcho(srv);
        await roundTrip(s, 100_000);
        await c.stop('shutdown');
        expect(c.state).toBe('stopped');
        expect(saved.value).toEqual({ day: '2026-11-16', bytes: 200_000 });
    });
});

describe('opt-out and GOAWAY', () => {
    it('opt-out with eight open streams closes them all and the tunnel within 5 s', async () => {
        const srv = await testServer();
        const echo = await echoTarget();
        cleanups.push(srv.close, echo.close);
        const { c } = client(srv.url, {}, echo.port);
        c.start();
        await until(() => c.state === 'open');
        const streams = await Promise.all(Array.from({ length: 8 }, () => openEcho(srv)));
        const closed = Promise.all(streams.map((s) => new Promise<void>((r) => s.once('close', () => r()))));
        const t0 = Date.now();
        await c.stop('optout');
        await closed;
        await until(() => srv.state.ws?.readyState === 3);
        expect(Date.now() - t0).toBeLessThan(5000);
        expect(drains(srv)).toEqual(['optout']);
    });

    it('GOAWAY: an open stream is allowed to finish before the device reconnects', async () => {
        const srv = await testServer();
        const echo = await echoTarget();
        cleanups.push(srv.close, echo.close);
        const { c } = client(srv.url, {}, echo.port);
        c.start();
        await until(() => c.state === 'open');
        const s = await openEcho(srv);
        srv.state.ws!.send(encodeJson(FrameType.GOAWAY, 0, { reason: 'deploy', reconnect_after_ms: 50 }));
        await sleep(300);
        expect(srv.state.hellos).toHaveLength(1); // still on the old tunnel: the stream is open
        await roundTrip(s, 50_000); // and it still works
        s.end();
        await until(() => srv.state.hellos.length === 2, 3000); // closed after the stream, then reconnected
    });

    it('GOAWAY: a stream that never ends does not hold the device past the wait limit', async () => {
        const srv = await testServer();
        const echo = await echoTarget();
        cleanups.push(srv.close, echo.close);
        const { c } = client(srv.url, { goawayMaxWaitMs: 300 }, echo.port);
        c.start();
        await until(() => c.state === 'open');
        await openEcho(srv);
        srv.state.ws!.send(encodeJson(FrameType.GOAWAY, 0, { reason: 'deploy', reconnect_after_ms: 0 }));
        await until(() => srv.state.hellos.length === 2, 3000);
    });
});

describe('flow control on the device', () => {
    it('a stream the server stops reading does not hold up another; device memory stays bounded', async () => {
        const srv = await testServer();
        const echo = await echoTarget();
        cleanups.push(srv.close, echo.close);
        const { c } = client(srv.url, {}, echo.port);
        c.start();
        await until(() => c.state === 'open');
        const stalled = await openEcho(srv);
        stalled.pause(); // the server never reads stream A's echo
        const fast = await openEcho(srv);
        const heap0 = process.memoryUsage().heapUsed;
        stalled.write(randomBytes(4 * 1024 * 1024));
        const payload = randomBytes(8 * 1024 * 1024);
        const got: Buffer[] = [];
        let n = 0;
        const done = new Promise<void>((r) => fast.on('data', (b: Buffer) => { got.push(b); n += b.length; if (n >= payload.length) r(); }));
        fast.write(payload);
        await done;
        expect(createHash('sha256').update(Buffer.concat(got)).digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'));
        expect(process.memoryUsage().heapUsed - heap0).toBeLessThan(64 * 1024 * 1024);
    });
});
