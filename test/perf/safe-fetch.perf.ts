/**
 * Plan cases 1.2-T4 (load), 1.2-T5 (soak), 1.2-T6 (CPU), 1.2-T7 (stress/failure).
 *
 * Simulated: a local HTTP server stands in for target sites. "plain" is the
 * runtime's built-in fetch to the same server, i.e. what the SDK does today.
 *
 * Knobs (env):
 *   LOAD_REQUESTS (10000)  LOAD_CONCURRENCY (50)
 *   SOAK_REQUESTS (60000)  SOAK_CONCURRENCY (20)   accelerated soak
 *   SOAK_MINUTES (0)       SOAK_RATE (1.74 req/s)  paced soak, real time (0 = skip)
 *   PERF_OUT               optional path to write a JSON summary
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'fs';
import { createSafeFetch } from '../../src/net/safe-fetch';
import { systemResolver, isBlockedAddress, type Resolver } from '../../src/net/destination-check';
import { startHttp, testIsBlocked, type Fixture } from '../helpers/servers';

const env = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
const summary: Record<string, unknown> = { node: process.version, platform: process.platform, arch: process.arch };

let h: Fixture;
beforeAll(async () => { h = await startHttp({ record: false }); });
afterAll(async () => {
    await h.close();
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify(summary, null, 2));
    console.log('\nPERF SUMMARY\n' + JSON.stringify(summary, null, 2));
});

// public.test resolves through the real system resolver (getaddrinfo) to
// 127.0.0.1, so the DNS + check cost is on the measured path.
const realishResolver: Resolver = async (host) => systemResolver(host === 'public.test' ? '127.0.0.1' : host);

function newSafe(extra: Parameters<typeof createSafeFetch>[0] = {}) {
    return createSafeFetch({ resolver: realishResolver, isBlocked: testIsBlocked, ports: [h.port], ...extra });
}

const pct = (xs: number[], p: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

/** Mixed workload: 80% direct, 20% one redirect. */
function pathFor(i: number) {
    return i % 5 === 0 ? `/redirect?to=${encodeURIComponent('/bytes?n=4096')}` : '/bytes?n=4096';
}

async function runPool(n: number, concurrency: number, one: (i: number) => Promise<void>) {
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
        while (true) {
            const i = next++;
            if (i >= n) return;
            await one(i);
        }
    }));
}

async function measure(n: number, concurrency: number, doFetch: (path: string) => Promise<Response | any>) {
    const lat: number[] = [];
    let errors = 0;
    const t0 = performance.now();
    await runPool(n, concurrency, async (i) => {
        const s = performance.now();
        try {
            const r = await doFetch(pathFor(i));
            await r.arrayBuffer();
            if (r.status !== 200) errors++;
        } catch {
            errors++;
        }
        lat.push(performance.now() - s);
    });
    const wall = performance.now() - t0;
    return { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), errors, rps: n / (wall / 1000) };
}

const tcpSockets = () => (process as any).getActiveResourcesInfo().filter((x: string) => x === 'TCPSocketWrap').length as number;
const gc = () => (global as any).gc?.();

describe('1.2-T4 load: safeFetch vs plain fetch', () => {
    it('added latency within budget, zero errors', async () => {
        const N = env('LOAD_REQUESTS', 10000), C = env('LOAD_CONCURRENCY', 50);
        const sf = newSafe();
        const plain = (p: string) => fetch(`http://127.0.0.1:${h.port}${p}`);
        const safe = (p: string) => sf.fetch(`http://public.test:${h.port}${p}`);
        // Warm-up both, then interleave two measured rounds to cancel drift.
        await measure(500, C, plain); await measure(500, C, safe);
        const rounds = [] as Array<{ plain: any; safe: any }>;
        for (let r = 0; r < 2; r++) rounds.push({ plain: await measure(N / 2, C, plain), safe: await measure(N / 2, C, safe) });
        const avg = (k: 'plain' | 'safe', m: string) => rounds.reduce((a, r) => a + r[k][m], 0) / rounds.length;
        const res = {
            requests: N, concurrency: C, redirectShare: 0.2,
            plain: { p50: round(avg('plain', 'p50')), p95: round(avg('plain', 'p95')), p99: round(avg('plain', 'p99')), rps: round(avg('plain', 'rps'), 0), errors: rounds.reduce((a, r) => a + r.plain.errors, 0) },
            safe: { p50: round(avg('safe', 'p50')), p95: round(avg('safe', 'p95')), p99: round(avg('safe', 'p99')), rps: round(avg('safe', 'rps'), 0), errors: rounds.reduce((a, r) => a + r.safe.errors, 0) },
        };
        const added = { p50: round(res.safe.p50 - res.plain.p50), p95: round(res.safe.p95 - res.plain.p95) };
        summary['1.2-T4'] = { ...res, addedMs: added };
        await sf.close();
        expect(res.safe.errors).toBe(0);
        expect(added.p50).toBeLessThan(5);
        expect(added.p95).toBeLessThan(20);
    });
});

describe('1.2-T6 CPU: safeFetch vs plain fetch', () => {
    it('CPU per 1,000 requests within 10% of plain fetch', async () => {
        const sf = newSafe();
        const plain = (p: string) => fetch(`http://127.0.0.1:${h.port}${p}`);
        const safe = (p: string) => sf.fetch(`http://public.test:${h.port}${p}`);
        const cpuOf = async (f: (p: string) => Promise<any>) => {
            const c0 = process.cpuUsage();
            await runPool(1000, 10, async (i) => { const r = await f(pathFor(i)); await r.arrayBuffer(); });
            const c = process.cpuUsage(c0);
            return (c.user + c.system) / 1000; // ms
        };
        await cpuOf(plain); await cpuOf(safe); // warm-up
        const p: number[] = [], s: number[] = [];
        for (let r = 0; r < 7; r++) { p.push(await cpuOf(plain)); s.push(await cpuOf(safe)); }
        // Note: this process also runs the fixture server; its CPU is the same in both arms.
        const med = (xs: number[]) => pct(xs, 50);
        const overhead = (med(s) - med(p)) / med(p);
        summary['1.2-T6'] = { cpuMsPer1000: { plain: round(med(p)), safe: round(med(s)) }, overheadPct: round(overhead * 100, 1), rounds: 7, note: 'process CPU incl. in-process fixture server' };
        await sf.close();
        expect(overhead).toBeLessThan(0.10);
    });
});

describe('1.2-T5 soak (accelerated): memory and sockets stay flat', () => {
    it('heap, RSS and sockets show no growth trend', async () => {
        const N = env('SOAK_REQUESTS', 60000), C = env('SOAK_CONCURRENCY', 20), STEP = Math.max(1000, Math.floor(N / 12));
        const sf = newSafe();
        const samples: Array<{ done: number; heapMB: number; rssMB: number; sockets: number; serverConns: number }> = [];
        let blocked = 0, dnsFail = 0, ok = 0, other = 0;
        // Workload mix: 70% direct, 20% redirect, 5% redirect to a private target (refused), 5% DNS failure.
        const one = async (i: number) => {
            const k = i % 20;
            const url = k === 0 ? `http://public.test:${h.port}/redirect?to=${encodeURIComponent('http://10.0.0.1/')}`
                : k === 1 ? `http://nx.test:${h.port}/`
                    : `http://public.test:${h.port}${pathFor(i)}`;
            try { const r = await sf.fetch(url); await r.arrayBuffer(); ok++; }
            catch (e: any) { if (e?.code === 'EGRESS_BLOCKED') blocked++; else if (e instanceof TypeError) dnsFail++; else other++; }
        };
        for (let done = 0; done < N; done += STEP) {
            await runPool(STEP, C, (i) => one(done + i));
            gc(); gc();
            const m = process.memoryUsage();
            samples.push({ done: done + STEP, heapMB: round(m.heapUsed / 2 ** 20), rssMB: round(m.rss / 2 ** 20), sockets: tcpSockets(), serverConns: await h.connections() });
        }
        await sf.close();
        await new Promise((r) => setTimeout(r, 200));
        const after = { sockets: tcpSockets(), serverConns: await h.connections() };
        // Baseline: sockets the built-in fetch keeps at the same concurrency and mix (direct + redirect).
        await runPool(STEP, C, async (i) => { const r = await fetch(`http://127.0.0.1:${h.port}${pathFor(i)}`); await r.arrayBuffer(); });
        const plainSockets = tcpSockets();
        // Trend: compare mean of the last third with the mean of the second third (after warm-up).
        const third = Math.floor(samples.length / 3);
        const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
        const heapMid = mean(samples.slice(third, 2 * third).map((s) => s.heapMB));
        const heapEnd = mean(samples.slice(2 * third).map((s) => s.heapMB));
        const rssMid = mean(samples.slice(third, 2 * third).map((s) => s.rssMB));
        const rssEnd = mean(samples.slice(2 * third).map((s) => s.rssMB));
        summary['1.2-T5'] = { requests: N, concurrency: C, outcomes: { ok, blocked, dnsFail, other }, samples, heapGrowthMB: round(heapEnd - heapMid), rssGrowthMB: round(rssEnd - rssMid), afterClose: after, plainSocketsAtSameConcurrency: plainSockets, equivalentDeviceDaysAt15k: round(N / 15000, 1) };
        expect(other).toBe(0);
        expect(blocked).toBe(N / 20);
        expect(heapEnd - heapMid).toBeLessThan(5);           // MB
        expect(rssEnd - rssMid).toBeLessThan(30);            // MB, allocator noise
        // Sockets: keep-alive pools hold more than C (built-in fetch does the same, see
        // plainSocketsAtSameConcurrency). Requirement: bounded, no growth trend.
        const sockMid = Math.max(...samples.slice(third, 2 * third).map((s) => s.sockets));
        const sockEnd = Math.max(...samples.slice(2 * third).map((s) => s.sockets));
        expect(sockEnd).toBeLessThanOrEqual(sockMid);
        expect(sockEnd).toBeLessThanOrEqual(Math.max(3 * C, (summary['1.2-T5'] as any).plainSocketsAtSameConcurrency + 5));
        expect(after.serverConns).toBe(0);                   // nothing left open after close
    });

    const minutes = env('SOAK_MINUTES', 0);
    it.runIf(minutes > 0)(`paced soak at real device rate for ${minutes} min`, async () => {
        const rate = env('SOAK_RATE', 1.74);
        const sf = newSafe();
        const end = Date.now() + minutes * 60_000;
        const samples: Array<{ min: number; heapMB: number; rssMB: number; sockets: number }> = [];
        let i = 0, errors = 0, nextSample = Date.now();
        while (Date.now() < end) {
            try { const r = await sf.fetch(`http://public.test:${h.port}${pathFor(i++)}`); await r.arrayBuffer(); } catch { errors++; }
            if (Date.now() >= nextSample) {
                gc();
                const m = process.memoryUsage();
                samples.push({ min: round((Date.now() - (end - minutes * 60_000)) / 60_000, 1), heapMB: round(m.heapUsed / 2 ** 20), rssMB: round(m.rss / 2 ** 20), sockets: tcpSockets() });
                nextSample = Date.now() + 60_000;
            }
            await new Promise((r) => setTimeout(r, 1000 / rate));
        }
        await sf.close();
        const half = Math.floor(samples.length / 2);
        const heapGrowth = samples[samples.length - 1].heapMB - samples[half].heapMB;
        summary['1.2-T5-paced'] = { minutes, rate, requests: i, errors, heapGrowthMB: round(heapGrowth), maxSockets: Math.max(...samples.map((s) => s.sockets)), samples };
        expect(errors).toBe(0);
        expect(heapGrowth).toBeLessThan(5);
    });
});

describe('1.2-T7 stress and failure: clean errors, no hangs, no leaked sockets', () => {
    const sockets0 = () => tcpSockets();

    it('resolver that never answers → error at the connect timeout (test: 1 s)', async () => {
        const hang: Resolver = () => new Promise(() => undefined);
        const sf = createSafeFetch({ resolver: hang, isBlocked: testIsBlocked, ports: [h.port], connect: { timeout: 1000 } });
        const t0 = performance.now();
        const err = await sf.fetch(`http://public.test:${h.port}/`).then(() => null, (e) => e);
        const ms = performance.now() - t0;
        await sf.close();
        (summary['1.2-T7'] ??= {} as any)['hangingResolver1s'] = { ms: round(ms, 0), error: String(err?.cause?.code ?? err?.cause?.name ?? err) };
        expect(err).toBeInstanceOf(TypeError);
        expect(ms).toBeLessThan(2500);
    });

    it('resolver that never answers → error at the production default timeout (10 s)', async () => {
        const hang: Resolver = () => new Promise(() => undefined);
        const sf = createSafeFetch({ resolver: hang, isBlocked: testIsBlocked, ports: [h.port] });
        const t0 = performance.now();
        const err = await sf.fetch(`http://public.test:${h.port}/`).then(() => null, (e) => e);
        const ms = performance.now() - t0;
        await sf.close();
        (summary['1.2-T7'] as any)['hangingResolverDefault'] = { ms: round(ms, 0), error: String(err?.cause?.code ?? err?.cause?.name ?? err) };
        expect(err).toBeInstanceOf(TypeError);
        expect(ms).toBeLessThan(12000);
    });

    it('slow resolver (5 s) under the default timeout → succeeds, not cut short', async () => {
        const slow: Resolver = async () => { await new Promise((r) => setTimeout(r, 5000)); return [{ address: '127.0.0.1', family: 4 }]; };
        const sf = createSafeFetch({ resolver: slow, isBlocked: testIsBlocked, ports: [h.port] });
        const t0 = performance.now();
        const r = await sf.fetch(`http://public.test:${h.port}/`);
        const ms = performance.now() - t0;
        await r.arrayBuffer();
        await sf.close();
        (summary['1.2-T7'] as any)['slowResolver5s'] = { ms: round(ms, 0), status: r.status };
        expect(r.status).toBe(200);
    });

    it('resolver error → TypeError fetch failed (not EGRESS_BLOCKED)', async () => {
        const failing: Resolver = async () => { throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }); };
        const sf = createSafeFetch({ resolver: failing, isBlocked: testIsBlocked, ports: [h.port] });
        const err = await sf.fetch(`http://public.test:${h.port}/`).then(() => null, (e) => e);
        await sf.close();
        expect(err).toBeInstanceOf(TypeError);
        expect(err.code).toBeUndefined();
    });

    it('50-address answer: all public → works; one private at the end → refused', async () => {
        const many = ['127.0.0.1', ...Array.from({ length: 49 }, (_, i) => `1.1.${Math.floor(i / 250)}.${(i % 250) + 1}`)];
        const ok = createSafeFetch({ resolver: async () => many.map((address) => ({ address, family: 4 })), isBlocked: testIsBlocked, ports: [h.port] });
        const r = await ok.fetch(`http://public.test:${h.port}/`);
        expect(r.status).toBe(200);
        await r.arrayBuffer();
        await ok.close();
        const bad = createSafeFetch({ resolver: async () => [...many.slice(0, 49), '10.0.0.1'].map((address) => ({ address, family: 4 })), isBlocked: testIsBlocked, ports: [h.port] });
        const err = await bad.fetch(`http://public.test:${h.port}/`).then(() => null, (e) => e);
        await bad.close();
        expect(err?.code).toBe('EGRESS_BLOCKED');
    });

    it('redirect loop → fails after 20 hops, quickly', async () => {
        const sf = newSafe();
        const t0 = performance.now();
        const err = await sf.fetch(`http://public.test:${h.port}/loop`).then(() => null, (e) => e);
        const ms = performance.now() - t0;
        await sf.close();
        (summary['1.2-T7'] as any)['redirectLoop'] = { ms: round(ms, 0) };
        expect(err).toBeInstanceOf(TypeError);
        expect(String(err.cause?.message)).toMatch(/redirect count exceeded/);
        expect(ms).toBeLessThan(2000);
    });

    it('500 concurrent refusals and failures leave no sockets behind', async () => {
        const base = sockets0();
        const sf = newSafe();
        await Promise.all(Array.from({ length: 500 }, (_, i) => {
            const u = i % 2 ? `http://public.test:${h.port}/redirect?to=${encodeURIComponent('http://192.168.1.1/')}` : `http://nx.test:${h.port}/`;
            return sf.fetch(u).then((r) => r.arrayBuffer(), () => undefined);
        }));
        await sf.close();
        await new Promise((r) => setTimeout(r, 200));
        (summary['1.2-T7'] as any)['socketsAfter500Failures'] = { before: base, after: sockets0(), serverConns: await h.connections() };
        expect(sockets0()).toBeLessThanOrEqual(base);
        expect(await h.connections()).toBe(0);
    });

    it('real rules sanity: the perf seams do not leak into production defaults', () => {
        expect(isBlockedAddress('127.0.0.1')).toBe(true);
    });
});
