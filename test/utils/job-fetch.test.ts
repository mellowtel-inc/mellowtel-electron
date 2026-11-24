import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fetchParserContent, makeFetchRequest } from '../../src/utils/job-fetch';
import { createSafeFetch } from '../../src/net/safe-fetch';
import { ObservedError } from '../../src/observability/observed-error';
import { classifyError } from '../../src/observability/classify';
import type { DataRequest } from '../../src/utils/data-request';
import { legacyMakeFetchRequest, legacyParserFetch } from '../helpers/legacy-fetch';
import { startHttp, testIsBlocked, mapResolver, type Fixture } from '../helpers/servers';

let h: Fixture;
let closedPort: number;
let testFetch: ReturnType<typeof createSafeFetch>;
beforeAll(async () => {
    h = await startHttp();
    const tmp = await startHttp();
    closedPort = tmp.port;
    await tmp.close();
    const r = mapResolver({ 'public.test': ['127.0.0.1'], 'router.test': ['192.168.1.1'] });
    testFetch = createSafeFetch({ resolver: r.resolver, isBlocked: testIsBlocked, ports: [h.port, closedPort] });
});
afterAll(async () => { await testFetch.close(); await h.close(); });

const legacyBase = () => `http://127.0.0.1:${h.port}`;
const newBase = () => `http://public.test:${h.port}`;
const dr = (over: Partial<DataRequest>) => ({ url: '', recordID: 'r1', method: 'GET', method_endpoint: '', method_payload: 'no_payload', method_headers: undefined, ...over }) as unknown as DataRequest;

/** Make old and new outputs comparable: only the host differs between the two runs. */
const norm = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (Buffer.isBuffer(v) ? v.toString('base64') : v)).split(newBase()).join('BASE').split(legacyBase()).join('BASE').split(`public.test:${h.port}`).join('HOST').split(`127.0.0.1:${h.port}`).join('HOST'));

async function outcome<T>(p: Promise<T>) {
    try {
        const v: any = await p;
        if (v && Buffer.isBuffer(v.content)) return { ok: true, contentType: v.contentType, content: v.content.toString('utf8') };
        return { ok: true, value: v };
    } catch (e: any) {
        return { ok: false, name: e?.name, code: e?.code, stage: e?.stage, message: e?.message, raw: e?.raw };
    }
}

describe('1.3-T1 allowed jobs: output identical to the pre-change code', () => {
    const cases: Array<[string, Partial<DataRequest>]> = [
        ['GET json', { method: 'GET', method_endpoint: '/echo' }],
        ['GET binary 64 KiB', { method: 'GET', method_endpoint: '/bytes?n=65536' }],
        ['POST with payload + headers', { method: 'POST', method_endpoint: '/echo', method_payload: '{"a":1}', method_headers: { 'content-type': 'application/json', 'x-custom': 'v' } }],
        ["payload 'no_payload' sends no body", { method: 'POST', method_endpoint: '/echo', method_payload: 'no_payload' }],
        ['default method GET_NORMAL', { method: 'GET_NORMAL', method_endpoint: '/echo' }],
        ['lower-case patch kept as sent', { method: 'patch', method_endpoint: '/echo', method_payload: 'x' }],
        ['lower-case post normalised', { method: 'post', method_endpoint: '/echo', method_payload: 'x' }],
        ['redirect 302 POST → GET', { method: 'POST', method_endpoint: `/redirect?to=${encodeURIComponent('/echo')}`, method_payload: 'x', method_headers: { 'content-type': 'text/plain' } }],
        ['redirect 307 keeps POST', { method: 'POST', method_endpoint: `/redirect?status=307&to=${encodeURIComponent('/echo')}`, method_payload: 'x' }],
        ['HTTP 404 error shape', { method: 'GET', method_endpoint: '/status?code=404&body=nope' }],
        ['HTTP 500 long body preview', { method: 'GET', method_endpoint: `/status?code=500&body=${'y'.repeat(3000)}` }],
        ['UTF-8 page', { method: 'GET', method_endpoint: '/page' }],
    ];
    for (const [name, c] of cases) {
        it(`makeFetchRequest: ${name}`, async () => {
            const old = await outcome(legacyMakeFetchRequest(dr({ ...c, method_endpoint: legacyBase() + c.method_endpoint })));
            const neu = await outcome(makeFetchRequest(dr({ ...c, method_endpoint: newBase() + c.method_endpoint }), testFetch.fetch));
            expect(norm(neu)).toEqual(norm(old));
        });
    }

    it('makeFetchRequest: connection refused has the same error shape', async () => {
        const old = await outcome(legacyMakeFetchRequest(dr({ method_endpoint: `http://127.0.0.1:${closedPort}/` })));
        const neu = await outcome(makeFetchRequest(dr({ method_endpoint: `http://public.test:${closedPort}/` }), testFetch.fetch));
        expect(old).toMatchObject({ ok: false, code: 'FETCH_FAILED', stage: 'fetch', raw: { error: 'TypeError: fetch failed' } });
        expect({ code: neu.code, stage: neu.stage, error: (neu.raw as any)?.error }).toEqual({ code: 'FETCH_FAILED', stage: 'fetch', error: 'TypeError: fetch failed' });
    });

    for (const [name, path] of [['200 html', '/page'], ['404', '/status?code=404'], ['500', '/status?code=500&body=boom']] as const) {
        it(`parser fetch: ${name}`, async () => {
            const old = await outcome(legacyParserFetch(legacyBase() + path));
            const neu = await outcome(fetchParserContent(newBase() + path, testFetch.fetch));
            expect(norm(neu)).toEqual(norm(old));
        });
    }

    it.runIf(process.env.NET_TESTS !== '0')('real site: production paths return the same bytes as before', async () => {
        const url = 'https://example.com/';
        const old = await outcome(legacyMakeFetchRequest(dr({ method_endpoint: url })));
        const neu = await outcome(makeFetchRequest(dr({ method_endpoint: url })));
        expect(neu).toEqual(old);
        expect(await fetchParserContent(url)).toEqual(await legacyParserFetch(url));
    }, 30000);
});

describe('1.3-T2 private targets: no request, EGRESS_BLOCKED reported', () => {
    const privateUrls = ['http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:3000/', 'http://[::1]/', 'http://10.0.0.1:8080/'];

    for (const u of privateUrls) {
        it(`makeFetchRequest refuses ${u} (production rules)`, async () => {
            const err = await makeFetchRequest(dr({ method_endpoint: u })).then(() => null, (e) => e);
            expect(err).toBeInstanceOf(ObservedError);
            expect(err.code).toBe('EGRESS_BLOCKED');
            expect(err.stage).toBe('fetch');
            expect(classifyError(err, 'x')).toEqual({ code: 'EGRESS_BLOCKED', stage: 'fetch' });
        });
        it(`parser fetch refuses ${u} (production rules)`, async () => {
            const err = await fetchParserContent(u).then(() => null, (e) => e);
            expect(err).toBeInstanceOf(ObservedError);
            expect(err.code).toBe('EGRESS_BLOCKED');
            expect(err.stage).toBe('parser_fetch');
        });
    }

    it('name resolving private: no request reaches any server; raw has reason + host, no address', async () => {
        const before = h.seen.length;
        const err = await makeFetchRequest(dr({ method: 'POST', method_endpoint: `http://router.test:${h.port}/admin`, method_payload: 'x' }), testFetch.fetch).then(() => null, (e) => e);
        expect(err.code).toBe('EGRESS_BLOCKED');
        expect(err.raw).toMatchObject({ reason: 'blocked_address', host: 'router.test', method: 'POST' });
        expect(JSON.stringify(err.raw)).not.toContain('192.168.1.1');
        expect(err.message).not.toContain('192.168.1.1');
        expect(h.seen.length).toBe(before);
    });

    it('redirect from an allowed site to a private one is refused mid-job', async () => {
        const before = h.seen.length;
        const err = await fetchParserContent(`${newBase()}/redirect?to=${encodeURIComponent('http://192.168.1.1/')}`, testFetch.fetch).then(() => null, (e) => e);
        expect(err.code).toBe('EGRESS_BLOCKED');
        expect(h.seen.length).toBe(before + 1); // the allowed first hop only
    });

    it('DNS failure stays FETCH_FAILED (not counted as EGRESS_BLOCKED)', async () => {
        const err = await makeFetchRequest(dr({ method_endpoint: `http://nx.test:${h.port}/` }), testFetch.fetch).then(() => null, (e) => e);
        expect(err.code).toBe('FETCH_FAILED');
    });
});
