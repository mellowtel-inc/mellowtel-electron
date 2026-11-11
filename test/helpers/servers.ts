/**
 * Local HTTP and HTTPS fixture servers for safe-fetch tests.
 *
 * Tests reach them through made-up names (public.test, other.test) that a stub
 * resolver maps to 127.0.0.1, with a test-only address rule that treats
 * exactly 127.0.0.1 as public. Literal 127.0.0.1 in a URL is still refused by
 * the real rules, which is what the redirect tests rely on.
 */
import http from 'http';
import https from 'https';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AddressInfo } from 'net';
import { isBlockedAddress, type Resolver } from '../../src/net/destination-check';

export interface Seen {
    method: string;
    url: string;
    host: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: string;
    remoteAddress: string | undefined;
    remotePort: number | undefined;
}

export interface Fixture {
    port: number;
    seen: Seen[];
    connections: () => Promise<number>;
    close: () => Promise<void>;
}

function handler(seen: Seen[], scheme: 'http' | 'https', record = true) {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (record) seen.push({ method: req.method!, url: req.url!, host: req.headers.host, headers: req.headers, body, remoteAddress: req.socket.remoteAddress, remotePort: req.socket.remotePort });
            const u = new URL(req.url!, `${scheme}://${req.headers.host}`);
            if (u.pathname === '/redirect') {
                res.writeHead(Number(u.searchParams.get('status') ?? 302), { location: u.searchParams.get('to')! });
                return res.end('moved');
            }
            const chain = /^\/chain\/(\d+)$/.exec(u.pathname);
            if (chain) {
                const n = Number(chain[1]);
                if (n > 0) {
                    res.writeHead(302, { location: `/chain/${n - 1}` });
                    return res.end();
                }
                res.writeHead(200, { 'content-type': 'text/plain' });
                return res.end('end of chain');
            }
            if (u.pathname === '/status') {
                res.writeHead(Number(u.searchParams.get('code') ?? 500), { 'content-type': 'text/html; charset=utf-8' });
                return res.end(u.searchParams.get('body') ?? '<h1>error</h1>');
            }
            if (u.pathname === '/page') {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                return res.end('<!doctype html><html><head><title>t</title></head><body><p>héllo — ünïcode ✓</p></body></html>');
            }
            if (u.pathname === '/loop') {
                res.writeHead(302, { location: '/loop' });
                return res.end();
            }
            if (u.pathname === '/close') {
                res.writeHead(200, { connection: 'close', 'content-type': 'text/plain' });
                return res.end('closed');
            }
            if (u.pathname === '/bytes') {
                const n = Number(u.searchParams.get('n') ?? 1024);
                res.writeHead(200, { 'content-type': 'application/octet-stream' });
                return res.end(Buffer.alloc(n, 120));
            }
            res.writeHead(200, { 'content-type': 'application/json', 'x-fixture': scheme });
            res.end(JSON.stringify({ method: req.method, path: req.url, body, host: req.headers.host, authorization: req.headers.authorization ?? null, contentType: req.headers['content-type'] ?? null, custom: req.headers['x-custom'] ?? null }));
        });
    };
}

async function listen(server: http.Server | https.Server, seen: Seen[]): Promise<Fixture> {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    server.keepAliveTimeout = 5000;
    return {
        port: (server.address() as AddressInfo).port,
        seen,
        connections: () => new Promise((r, j) => server.getConnections((e, n) => (e ? j(e) : r(n)))),
        close: () => new Promise((r) => {
            (server as http.Server).closeAllConnections?.();
            server.close(() => r());
        }),
    };
}

/** record=false for load/soak runs, so the fixture itself doesn't grow the heap. */
export async function startHttp(opts: { record?: boolean } = {}): Promise<Fixture> {
    const seen: Seen[] = [];
    return listen(http.createServer(handler(seen, 'http', opts.record ?? true)), seen);
}

export interface TlsMaterial { key: string; cert: string }

/** Self-signed cert for public.test / other.test, generated per run (nothing committed). */
export function makeCert(): TlsMaterial {
    const dir = mkdtempSync(join(tmpdir(), 'safe-fetch-cert-'));
    try {
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=public.test',
            '-addext', 'subjectAltName=DNS:public.test,DNS:other.test',
            '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
        ], { stdio: 'ignore' });
        return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

export function haveOpenssl(): boolean {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

export async function startHttps(tls: TlsMaterial): Promise<Fixture> {
    const seen: Seen[] = [];
    return listen(https.createServer({ key: tls.key, cert: tls.cert }, handler(seen, 'https')), seen);
}

/** Test address rule: real rules, except exactly 127.0.0.1 counts as public. */
export const testIsBlocked = (ip: string) => (ip === '127.0.0.1' ? false : isBlockedAddress(ip));

/** Resolver backed by a name → addresses map, counting calls per name. */
export function mapResolver(map: Record<string, string[] | (() => string[])>) {
    const calls: Record<string, number> = {};
    const resolver: Resolver = async (host) => {
        calls[host] = (calls[host] ?? 0) + 1;
        const v = map[host];
        if (!v) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
        const list = typeof v === 'function' ? v() : v;
        return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    };
    return { resolver, calls };
}
