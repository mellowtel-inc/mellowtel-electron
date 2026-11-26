/**
 * T5: zlib itself fails (out of memory, a native error). Compression is only an optimisation,
 * so a failure must never cost the upload: the body goes out plain, as it would with the flag off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

vi.mock('node:zlib', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:zlib')>();
    return {
        ...real,
        gzip: (_buf: unknown, _opts: unknown, cb: (err: Error | null) => void) => cb(new Error('zlib exploded')),
    };
});
vi.mock('../../src/utils/identity-helpers', () => ({ getIdentifier: () => 'mllwtl_test_node' }));

import { gzipBody } from '../../src/utils/gzip-body';
import { DataRequest } from '../../src/utils/data-request';
import { saveCrawl } from '../../src/utils/put-to-signed';
import { collectAndSendCaptures, parseBurkeObject } from '../../src/utils/meucci-helpers';

type Sent = { headers: Record<string, string>; body: unknown };
let sent: Sent[];

beforeEach(() => {
    sent = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
            sent.push({ headers: init.headers as Record<string, string>, body: init.body });
            return new Response('{"ok":true}', { status: 200 });
        })
    );
});
afterEach(() => vi.unstubAllGlobals());

describe('gzip failure falls back to a plain body', () => {
    it('gzipBody returns the plain body and headers', async () => {
        const json = 'x'.repeat(5000);
        const encoded = await gzipBody(json, 'text/plain', true);
        expect(encoded.gzipped).toBe(false);
        expect(encoded.body).toBe(json);
        expect(encoded.headers).toEqual({ 'Content-Type': 'text/plain' });
    });

    it('saveCrawl still uploads', async () => {
        const dr = DataRequest.fromJson({
            url: 'https://example.com/', orgId: 'o', recordID: 'r', saveHtml: true,
            save_html_endpoint: 'https://sink.test/save', gzipResponse: true,
        });
        await expect(saveCrawl(dr, 'x'.repeat(5000), undefined, false, '')).resolves.toEqual({ ok: true });
        expect(sent[0].headers).toEqual({ 'Content-Type': 'text/plain' });
        expect(typeof sent[0].body).toBe('string');
    });

    it('capture sink sends every capture', async () => {
        const config = parseBurkeObject(JSON.stringify({ endpoint: 'https://captures.test/' }), 'r', true)!;
        const win = {
            isDestroyed: () => false,
            webContents: {
                executeJavaScript: async (code: string) =>
                    code.includes('__MEUCCI_PENDING__')
                        ? 0
                        : JSON.stringify({ captures: [{ id: 1, b: 'x'.repeat(3000) }, { id: 2, b: 'y'.repeat(3000) }], stats: null }),
            },
        } as unknown as BrowserWindow;
        expect(await collectAndSendCaptures(win, config, 0)).toBe(2);
        expect(sent.every((s) => s.headers['Content-Encoding'] === undefined)).toBe(true);
    });
});
