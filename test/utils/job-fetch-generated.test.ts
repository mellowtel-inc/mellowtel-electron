/**
 * 1.3-T3: generated-payload equivalence. Fulfillment payloads are dynamic, so
 * instead of replaying fixed samples, generate many seeded random job payloads
 * and require the new job paths (safeFetch) to give exactly the same result as
 * the 700.0.36 code (built-in fetch) against the same local server.
 *
 * GEN_CASES (default 300) and GEN_SEED (default 20261112) control the run;
 * a failure message includes the case number and payload so it can be replayed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fetchParserContent, makeFetchRequest } from '../../src/utils/job-fetch';
import { createSafeFetch } from '../../src/net/safe-fetch';
import type { DataRequest } from '../../src/utils/data-request';
import { legacyMakeFetchRequest, legacyParserFetch } from '../helpers/legacy-fetch';
import { startHttp, testIsBlocked, mapResolver, type Fixture } from '../helpers/servers';

const CASES = Number(process.env.GEN_CASES ?? 300);
const SEED = Number(process.env.GEN_SEED ?? 20261112);

function rng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

let h: Fixture;
let sf: ReturnType<typeof createSafeFetch>;
beforeAll(async () => {
    h = await startHttp({ record: false });
    const r = mapResolver({ 'public.test': ['127.0.0.1'] });
    sf = createSafeFetch({ resolver: r.resolver, isBlocked: testIsBlocked, ports: [h.port] });
});
afterAll(async () => { await sf.close(); await h.close(); });

interface GenCase {
    kind: 'endpoint' | 'parser';
    path: string;
    method: string;
    payload: string;
    headers: Record<string, string> | undefined;
}

function generate(rand: () => number): GenCase {
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const int = (n: number) => Math.floor(rand() * n);
    const text = (n: number) => Array.from({ length: n }, () => pick(['a', 'Z', '7', ' ', 'é', '✓', '中', '&', '=', '%', '"', '/', '?', '#', '+'])).join('');
    const query = () => (rand() < 0.5 ? '' : `?q=${encodeURIComponent(text(1 + int(12)))}&page=${int(100)}${rand() < 0.3 ? '&flag' : ''}`);
    const target = pick([
        () => `/echo${query()}`,
        () => `/page${query()}`,
        () => `/bytes?n=${pick([0, 1, 1023, 4096, 65536, 262144])}`,
        () => `/status?code=${pick([200, 201, 202, 204, 400, 401, 403, 404, 410, 429, 500, 502, 503])}&body=${encodeURIComponent(text(int(40)))}`,
        () => `/redirect?status=${pick([301, 302, 303, 307, 308])}&to=${encodeURIComponent(pick(['/echo', '/page', `/echo${query()}`, '/bytes?n=10']))}`,
        () => `/chain/${int(4)}`,
    ])();
    const headers = rand() < 0.3 ? undefined : Object.fromEntries(
        Array.from({ length: int(4) }, () => pick<[string, string]>([
            ['content-type', pick(['application/json', 'text/plain', 'application/x-www-form-urlencoded', 'text/html; charset=utf-8'])],
            ['accept', pick(['*/*', 'application/json', 'text/html'])],
            ['x-custom', text(1 + int(10)).replace(/[^\x20-\x7e]/g, 'x')],
            ['user-agent', 'Mozilla/5.0 (generated)'],
            ['accept-language', pick(['en-US', 'de-DE,de;q=0.9', 'zh-HK'])],
        ])),
    );
    const payload = pick([
        'no_payload', 'no_payload', '',
        () => JSON.stringify({ q: text(1 + int(30)), n: int(1000), nested: { ok: rand() < 0.5 } }),
        () => `a=${encodeURIComponent(text(5))}&b=${int(9)}`,
        () => text(1 + int(200)),
        () => 'x'.repeat(65536),
    ].map((p) => (typeof p === 'function' ? p : () => p)))();
    return {
        kind: rand() < 0.75 ? 'endpoint' : 'parser',
        path: target,
        method: pick(['GET', 'GET', 'GET', 'POST', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'GET_NORMAL', 'post', 'get', 'patch']),
        payload,
        headers,
    };
}

const base = (host: string) => `http://${host}:${h.port}`;
const dr = (c: GenCase, host: string) => ({ url: base(host) + c.path, recordID: 'gen', method: c.method, method_endpoint: base(host) + c.path, method_payload: c.payload, method_headers: c.headers }) as unknown as DataRequest;

async function outcome(p: Promise<any>) {
    try {
        const v = await p;
        if (v && Buffer.isBuffer(v.content)) {
            // Text bodies compared as text (so the host normalisation below applies); anything else byte for byte.
            const text = v.content.toString('utf8');
            const isText = Buffer.from(text, 'utf8').equals(v.content);
            return { ok: true, contentType: v.contentType, content: isText ? text : `base64:${v.content.toString('base64')}` };
        }
        return { ok: true, value: v };
    } catch (e: any) {
        return { ok: false, name: e?.name, code: e?.code, stage: e?.stage, message: e?.message, raw: e?.raw };
    }
}

const normalise = (x: unknown) => JSON.parse(JSON.stringify(x).split(`public.test:${h.port}`).join('HOST').split(`127.0.0.1:${h.port}`).join('HOST'));

describe(`1.3-T3 generated payloads: new job paths = 700.0.36 behaviour (${CASES} cases, seed ${SEED})`, () => {
    it('every generated payload gives an identical result', async () => {
        const rand = rng(SEED);
        const mismatches: string[] = [];
        const tally = { endpoint: 0, parser: 0, ok: 0, error: 0 };
        for (let i = 0; i < CASES; i++) {
            const c = generate(rand);
            const [old, neu] = c.kind === 'endpoint'
                ? [await outcome(legacyMakeFetchRequest(dr(c, '127.0.0.1'))), await outcome(makeFetchRequest(dr(c, 'public.test'), sf.fetch))]
                : [await outcome(legacyParserFetch(base('127.0.0.1') + c.path)), await outcome(fetchParserContent(base('public.test') + c.path, sf.fetch))];
            tally[c.kind]++;
            tally[old.ok ? 'ok' : 'error']++;
            const a = JSON.stringify(normalise(old));
            const b = JSON.stringify(normalise(neu));
            if (a !== b) mismatches.push(`case ${i} ${JSON.stringify({ ...c, payload: c.payload.slice(0, 60) })}\n  old: ${a.slice(0, 300)}\n  new: ${b.slice(0, 300)}`);
        }
        console.log(`[1.3-T3] ${CASES} cases: ${tally.endpoint} method_endpoint, ${tally.parser} parser_job; ${tally.ok} succeeded, ${tally.error} errored (same on both sides)`);
        expect(mismatches.slice(0, 5).join('\n\n')).toBe('');
        expect(tally.ok).toBeGreaterThan(CASES * 0.3);
        expect(tally.error).toBeGreaterThan(CASES * 0.05);
    }, 120_000);
});
