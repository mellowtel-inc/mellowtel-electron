/**
 * Gzip result uploads against a real HTTP server, using the runtime's real fetch (no stubs).
 * The server mimics fulfillment's compress plugin: it gunzips any request with
 * `Content-Encoding: gzip` before parsing and leaves other bodies alone.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { BrowserWindow } from 'electron';

vi.mock('../../src/utils/identity-helpers', () => ({ getIdentifier: () => 'mllwtl_test_node' }));

import { DataRequest } from '../../src/utils/data-request';
import { saveCrawl } from '../../src/utils/put-to-signed';
import { collectAndSendCaptures, parseBurkeObject } from '../../src/utils/meucci-helpers';
import { ObservedError } from '../../src/observability/observed-error';
import { Logger } from '../../src/logger/logger';
import { legacyCaptureRequest, legacySaveCrawlRequest } from '../helpers/legacy-save';

interface Received {
    path: string;
    headers: http.IncomingHttpHeaders;
    /** Bytes as they arrived on the socket. */
    wire: Buffer;
    /** What the server parses: gunzipped when Content-Encoding is gzip. */
    text: string;
}

let server: http.Server;
let base: string;
let received: Received[] = [];
/** Paths that answer 500. */
const failPaths = new Set<string>();
/** When true, any gzip request gets 415, like a backend without the gunzip plugin. */
let rejectGzip = false;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const wire = Buffer.concat(chunks);
            const gz = req.headers['content-encoding'] === 'gzip';
            if (gz && rejectGzip) {
                res.writeHead(415, { 'Content-Type': 'text/plain' }).end('gzip not supported');
                return;
            }
            const text = (gz ? gunzipSync(wire) : wire).toString('utf8');
            received.push({ path: req.url || '', headers: req.headers, wire, text });
            if (failPaths.has(req.url || '')) {
                res.writeHead(500).end('boom');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

afterEach(() => {
    received = [];
    failPaths.clear();
    rejectGzip = false;
    vi.restoreAllMocks();
});

function job(extra: Record<string, unknown> = {}): DataRequest {
    return DataRequest.fromJson({
        url: 'https://example.com/',
        orgId: 'org_1',
        recordID: 'rec_1',
        saveHtml: true,
        save_html_endpoint: `${base}/save`,
        ...extra,
    });
}

/** Headers the server saw, minus the ones that differ per connection. */
function stableHeaders(h: http.IncomingHttpHeaders) {
    const { host, connection, ...rest } = h;
    return rest;
}

const bigHtml = '<main>' + '<p>Lorem ipsum dolor sit amet, café 雪 😀</p>'.repeat(400) + '</main>';

describe('T2 flag off is byte-identical to 700.0.37', () => {
    const cases: Array<[string, Record<string, unknown>, Parameters<typeof saveCrawl>]> = [
        ['flag absent, html', {}, [undefined as any, bigHtml, undefined, false, '']],
        ['flag false, html + markdown, batch', { gzipResponse: false, saveMarkdown: true }, [undefined as any, bigHtml, '# md 雪', true, 'batch_9']],
        ['flag "false", parser job', { gzipResponse: 'false', parser_job: true }, [undefined as any, '', undefined, false, '', false, { a: 'x'.repeat(3000) }]],
        ['flag absent, tiny body', { saveHtml: false }, [undefined as any, '', undefined, false, '']],
        ['flag absent, unreachable site', {}, [undefined as any, '', undefined, false, '', true, {}, '', false]],
    ];

    it.each(cases)('%s', async (_label, extra, args) => {
        const dr = job(extra);
        const [, ...rest] = args;
        await saveCrawl(dr, ...(rest as [any, any, any, any]));

        const legacy = legacySaveCrawlRequest(dr, 'mllwtl_test_node', ...(rest as [any, any, any, any]));
        const res = await fetch(legacy.endpoint, legacy.init);
        expect(res.status).toBe(200);

        expect(received).toHaveLength(2);
        const [now, before] = received;
        expect(now.path).toBe(before.path);
        expect(stableHeaders(now.headers)).toEqual(stableHeaders(before.headers));
        expect(now.headers['content-encoding']).toBeUndefined();
        expect(now.wire.equals(before.wire)).toBe(true);
    });

    it('capture sink, flag off', async () => {
        const capture = { id: 'c1', url: 'https://example.com/api', body: 'x'.repeat(5000) + '雪' };
        const config = parseBurkeObject(JSON.stringify({ endpoint: `${base}/captures` }), 'rec_1', false)!;
        await collectAndSendCaptures(fakeWindow([capture]), config, 0);

        const legacy = legacyCaptureRequest(`${base}/captures`, capture);
        await fetch(legacy.endpoint, legacy.init);

        const [now, before] = received;
        expect(stableHeaders(now.headers)).toEqual(stableHeaders(before.headers));
        expect(now.wire.equals(before.wire)).toBe(true);
    });
});

describe('T3 flag on, real wire', () => {
    it('saveCrawl: server sees gzip with correct framing and parses the same JSON', async () => {
        await saveCrawl(job(), bigHtml, undefined, false, '');
        await saveCrawl(job({ gzipResponse: true }), bigHtml, undefined, false, '');

        const [plain, gz] = received;
        expect(gz.headers['content-encoding']).toBe('gzip');
        expect(gz.headers['content-type']).toBe('text/plain');
        expect(Number(gz.headers['content-length'])).toBe(gz.wire.length);
        expect(gz.headers['transfer-encoding']).toBeUndefined();
        expect(gz.wire.length).toBeLessThan(plain.wire.length / 5);

        const a = JSON.parse(plain.text);
        const b = JSON.parse(gz.text);
        expect(b.content).toBe(bigHtml);
        expect({ ...b, requestMessageInfo: null }).toEqual({ ...a, requestMessageInfo: null });
        expect(b.requestMessageInfo.gzipResponse).toBe(true);
    });

    it('capture sink: mixed sizes, each request framed independently', async () => {
        const caps = [
            { id: 'small', body: 'hi' },
            { id: 'big', body: 'y'.repeat(20_000) },
            { id: 'edge', body: '😀'.repeat(260) },
        ];
        const config = parseBurkeObject(JSON.stringify({ endpoint: `${base}/captures` }), 'rec_1', true)!;
        expect(await collectAndSendCaptures(fakeWindow(caps), config, 0)).toBe(3);

        expect(received.map((r) => r.headers['content-encoding'] ?? 'plain')).toEqual(['plain', 'gzip', 'gzip']);
        received.forEach((r, i) => {
            expect(Number(r.headers['content-length'])).toBe(r.wire.length);
            expect(JSON.parse(r.text)).toEqual(caps[i]);
        });
    });
});

describe('T3b no data lost: unzipped bytes equal the plain body exactly', () => {
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

    /** Random text drawn from the awkward parts of Unicode and JSON. */
    function randomText(rand: () => number, len: number): string {
        const pools = [
            () => String.fromCharCode(32 + Math.floor(rand() * 95)),             // printable ASCII
            () => String.fromCharCode(Math.floor(rand() * 32)),                  // control chars incl. \0, \n, \t
            () => '"\\/<>&\'',                                                   // JSON / HTML specials
            () => String.fromCodePoint(0xa0 + Math.floor(rand() * 0x700)),      // Latin, Greek, Cyrillic, Hebrew, Arabic
            () => String.fromCodePoint(0x4e00 + Math.floor(rand() * 0x5000)),   // CJK (3-byte UTF-8)
            () => String.fromCodePoint(0x1f300 + Math.floor(rand() * 0x300)),  // emoji (4-byte UTF-8)
            () => '‍﻿‮',                                          // zero-width joiner, BOM, RTL override
            () => (rand() < 0.5 ? '\ud800' : '\udfff'),                          // lone surrogates
        ];
        let s = '';
        while (s.length < len) s += pools[Math.floor(rand() * pools.length)]();
        return s;
    }

    it('saveCrawl: 200 random payloads around and above the 1 KiB threshold', async () => {
        let seed = 20261126;
        const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
        let gzipped = 0;
        for (let i = 0; i < 200; i++) {
            received = [];
            // First 100 straddle the 1 KiB threshold (the fixed fields are ~600 bytes),
            // the rest go up to ~1 MB.
            const small = i < 100;
            const content = randomText(rand, small ? Math.floor(rand() * 250) : Math.floor(rand() * 300_000));
            const markdown = small ? undefined : randomText(rand, Math.floor(rand() * 2000));
            const cereal = small ? {} : { title: randomText(rand, 50), n: rand(), list: [randomText(rand, 30), null, true] };
            const dr = job({ gzipResponse: true, saveMarkdown: !small });
            await saveCrawl(dr, content, markdown, false, 'b' + i, false, cereal);

            // What the flag-off code would have sent for this exact job, byte for byte.
            const plainBody = Buffer.from(
                legacySaveCrawlRequest(dr, 'mllwtl_test_node', content, markdown, false, 'b' + i, false, cereal).init.body,
                'utf8'
            );
            const r = received[0];
            const unzipped = r.headers['content-encoding'] === 'gzip' ? gunzipSync(r.wire) : r.wire;
            if (r.headers['content-encoding'] === 'gzip') gzipped++;
            expect(unzipped.length, `payload ${i}`).toBe(plainBody.length);
            expect(sha(unzipped), `payload ${i}`).toBe(sha(plainBody));
            expect(unzipped.equals(plainBody), `payload ${i}`).toBe(true);
        }
        console.log(`[T3b] saveCrawl: 200 payloads byte-identical after unzip (${gzipped} gzipped, ${200 - gzipped} under threshold)`);
        expect(gzipped).toBeGreaterThan(120);
        expect(200 - gzipped).toBeGreaterThan(20);
    });

    it('capture sink: 100 random captures', async () => {
        let seed = 7;
        const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
        const caps = Array.from({ length: 100 }, (_, i) => ({
            id: `c${i}`,
            url: 'https://example.com/' + randomText(rand, 20),
            body: randomText(rand, Math.floor(rand() * 20_000)),
            headers: { 'x-weird': randomText(rand, 40) },
        }));
        const config = parseBurkeObject(JSON.stringify({ endpoint: `${base}/captures` }), 'rec_1', true)!;
        expect(await collectAndSendCaptures(fakeWindow(caps), config, 0)).toBe(100);
        received.forEach((r, i) => {
            const plainBody = Buffer.from(legacyCaptureRequest('', caps[i]).init.body, 'utf8');
            const unzipped = r.headers['content-encoding'] === 'gzip' ? gunzipSync(r.wire) : r.wire;
            expect(unzipped.equals(plainBody), `capture ${i}`).toBe(true);
        });
        const n = received.filter((r) => r.headers['content-encoding'] === 'gzip').length;
        console.log(`[T3b] captures: 100 byte-identical after unzip (${n} gzipped)`);
    });

    it('a 19 MB body survives byte for byte', async () => {
        const content = randomBytes(9_000_000).toString('base64') + '雪😀'.repeat(1_000_000);
        const dr = job({ gzipResponse: true });
        await saveCrawl(dr, content, undefined, false, '');
        const plainBody = Buffer.from(legacySaveCrawlRequest(dr, 'mllwtl_test_node', content, undefined, false, '').init.body, 'utf8');
        const unzipped = gunzipSync(received[0].wire);
        console.log(`[T3b] ${plainBody.length} B body -> ${received[0].wire.length} B gzip, sha256 match: ${sha(unzipped) === sha(plainBody)}`);
        expect(sha(unzipped)).toBe(sha(plainBody));
    });
});

describe('T4 awkward content', () => {
    it('20 MB page compresses and round-trips in reasonable time', async () => {
        const html = '<div class="row">' + 'item 雪 '.repeat(2_500_000) + '</div>';
        const t0 = Date.now();
        await saveCrawl(job({ gzipResponse: true }), html, undefined, false, '');
        const ms = Date.now() - t0;
        const r = received[0];
        console.log(`[T4] 20MB page: raw ${Buffer.byteLength(r.text)} B -> wire ${r.wire.length} B in ${ms} ms`);
        expect(JSON.parse(r.text).content).toBe(html);
        expect(ms).toBeLessThan(10_000);
    });

    it('incompressible content: gzip overhead stays tiny and data survives', async () => {
        const noise = randomBytes(300_000).toString('base64');
        const unicodeNoise = Array.from(randomBytes(60_000), (b) => String.fromCodePoint(0x4e00 + b * 37)).join('');
        for (const content of [noise, unicodeNoise]) {
            received = [];
            await saveCrawl(job(), content, undefined, false, '');
            await saveCrawl(job({ gzipResponse: true }), content, undefined, false, '');
            const [plain, gz] = received;
            console.log(`[T4] incompressible: plain ${plain.wire.length} B, gzip ${gz.wire.length} B`);
            expect(gz.wire.length).toBeLessThan(plain.wire.length * 1.01);
            expect(JSON.parse(gz.text).content).toBe(content);
        }
    });

    it('broken UTF-16 (lone surrogates) decodes the same as a plain upload', async () => {
        const content = 'start \uD800 middle \uDFFF end ' + 'z'.repeat(2000);
        await saveCrawl(job(), content, undefined, false, '');
        await saveCrawl(job({ gzipResponse: true }), content, undefined, false, '');
        const [plain, gz] = received;
        expect(gz.headers['content-encoding']).toBe('gzip');
        // JSON.stringify escapes lone surrogates, so both arrive as the same ASCII escapes.
        const raw = (t: string) => t.slice(t.indexOf('"content":'));
        expect(raw(gz.text)).toContain('\\ud800');
        expect(raw(gz.text)).toBe(raw(plain.text));
        expect(JSON.parse(gz.text).content).toBe(content);
    });

    it('empty capture list sends nothing', async () => {
        const config = parseBurkeObject(JSON.stringify({ endpoint: `${base}/captures` }), 'rec_1', true)!;
        expect(await collectAndSendCaptures(fakeWindow([]), config, 0)).toBe(0);
        expect(received).toHaveLength(0);
    });
});

describe('T5 failures', () => {
    it('backend without gunzip: flag on fails loudly, flag off (rollback) succeeds', async () => {
        rejectGzip = true;
        const err = await saveCrawl(job({ gzipResponse: true }), bigHtml, undefined, false, '').catch((e) => e);
        expect(err).toBeInstanceOf(ObservedError);
        expect(err.code).toBe('SAVE_CRAWL_FAILED');
        expect(err.raw.status).toBe(415);

        await expect(saveCrawl(job({ gzipResponse: false }), bigHtml, undefined, false, '')).resolves.toEqual({ ok: true });
    });

    it('capture sink 500 on one capture does not stop the rest', async () => {
        failPaths.add('/captures');
        const config = parseBurkeObject(JSON.stringify({ endpoint: `${base}/captures` }), 'rec_1', true)!;
        const caps = [{ id: 'a', b: 'x'.repeat(3000) }, { id: 'b', b: 'y'.repeat(3000) }];
        expect(await collectAndSendCaptures(fakeWindow(caps), config, 0)).toBe(0);
        expect(received).toHaveLength(2);
    });
});

describe('T6 size-cap warning reflects what is sent', () => {
    const endpointCfg = () => JSON.stringify({ endpoint: `${base}/captures`, max_capture_bytes: 10_000_000 });

    it('flag on: a 6.5 MB capture that gzips small is not reported as over the cap', async () => {
        const spy = vi.spyOn(Logger, 'error');
        const config = parseBurkeObject(endpointCfg(), 'rec_1', true)!;
        await collectAndSendCaptures(fakeWindow([{ id: 'huge', body: 'a'.repeat(6_500_000) }]), config, 0);
        expect(received[0].wire.length).toBeLessThan(100_000);
        expect(spy.mock.calls.flat().join(' ')).not.toMatch(/over the sink's/);
    });

    it('flag off: the same capture still warns', async () => {
        const spy = vi.spyOn(Logger, 'error');
        const config = parseBurkeObject(endpointCfg(), 'rec_1', false)!;
        await collectAndSendCaptures(fakeWindow([{ id: 'huge', body: 'a'.repeat(6_500_000) }]), config, 0);
        expect(spy.mock.calls.flat().join(' ')).toMatch(/over the sink's/);
    });
});

function fakeWindow(captures: unknown[]): BrowserWindow {
    return {
        isDestroyed: () => false,
        webContents: {
            executeJavaScript: async (code: string) =>
                code.includes('__MEUCCI_PENDING__') ? 0 : JSON.stringify({ captures, stats: null }),
        },
    } as unknown as BrowserWindow;
}
