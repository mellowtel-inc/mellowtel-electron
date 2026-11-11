import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSafeFetch, safeFetch, isEgressBlocked } from '../../src/net/safe-fetch';
import { DestinationBlockedError } from '../../src/net/destination-check';
import { startHttp, startHttps, makeCert, haveOpenssl, testIsBlocked, mapResolver, type Fixture, type TlsMaterial } from '../helpers/servers';

async function rejectionOf(p: Promise<unknown>): Promise<any> {
    return p.then(() => { throw new Error('expected rejection'); }, (e) => e);
}

let h: Fixture;
beforeAll(async () => { h = await startHttp(); });
afterAll(async () => { await h.close(); });

function client(map: Parameters<typeof mapResolver>[0], extra: Partial<Parameters<typeof createSafeFetch>[0]> = {}) {
    const r = mapResolver(map);
    const sf = createSafeFetch({ resolver: r.resolver, isBlocked: testIsBlocked, ports: [80, 443, h.port], ...extra });
    return { ...sf, calls: r.calls };
}

describe('1.2-T1 connection goes only to the checked address (DNS rebinding)', () => {
    it('one resolution per connection; second connection resolving private is refused', async () => {
        let n = 0;
        const c = client({ 'public.test': () => (n++ === 0 ? ['127.0.0.1'] : ['10.0.0.1']) });
        const before = h.seen.length;
        const ok = await c.fetch(`http://public.test:${h.port}/close`);
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe('closed');
        expect(c.calls['public.test']).toBe(1); // checked once, connected with that answer
        expect(h.seen[h.seen.length - 1].host).toBe(`public.test:${h.port}`); // Host header keeps the name

        const err = await rejectionOf(c.fetch(`http://public.test:${h.port}/close`));
        expect(err).toBeInstanceOf(DestinationBlockedError);
        expect(err.reason).toBe('blocked_address');
        expect(isEgressBlocked(err)).toBe(true);
        expect(c.calls['public.test']).toBe(2);
        expect(h.seen.length).toBe(before + 1); // the refused request never reached any server
        await c.close();
    });

    it('a mixed public+private answer is refused before connecting', async () => {
        const c = client({ 'mixed.test': ['127.0.0.1', '192.168.1.10'] });
        const before = h.seen.length;
        const err = await rejectionOf(c.fetch(`http://mixed.test:${h.port}/`));
        expect(err.reason).toBe('blocked_address');
        expect(h.seen.length).toBe(before);
        await c.close();
    });

    it('literal private URL is refused with no DNS and no socket', async () => {
        const c = client({});
        for (const u of [`http://127.0.0.1:${h.port}/`, 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://2130706433/']) {
            const err = await rejectionOf(c.fetch(u));
            expect(err, u).toBeInstanceOf(DestinationBlockedError);
        }
        expect(Object.keys(c.calls)).toHaveLength(0);
        await c.close();
    });

    it('DNS failure is an ordinary fetch failure, not EGRESS_BLOCKED', async () => {
        const c = client({});
        const err = await rejectionOf(c.fetch(`http://nx.test:${h.port}/`));
        expect(err).toBeInstanceOf(TypeError);
        expect(err.message).toBe('fetch failed');
        expect(isEgressBlocked(err)).toBe(false);
        expect(String(err.cause?.code ?? err.cause?.cause?.code)).toBe('ENOTFOUND');
        await c.close();
    });
});

describe('1.2-T2 every redirect hop is checked again', () => {
    it('redirect to http://127.0.0.1 is refused at the redirect; target never hit', async () => {
        const c = client({ 'public.test': ['127.0.0.1'] });
        const target = `http://127.0.0.1:${h.port}/secret`;
        const err = await rejectionOf(c.fetch(`http://public.test:${h.port}/redirect?to=${encodeURIComponent(target)}`));
        expect(err).toBeInstanceOf(DestinationBlockedError);
        expect(err.reason).toBe('blocked_address');
        expect(h.seen.some((s) => s.url === '/secret')).toBe(false);
        await c.close();
    });

    it('redirect to a name that resolves private is refused', async () => {
        const c = client({ 'public.test': ['127.0.0.1'], 'router.test': ['192.168.0.1'] });
        const err = await rejectionOf(c.fetch(`http://public.test:${h.port}/redirect?to=${encodeURIComponent(`http://router.test:${h.port}/admin`)}`));
        expect(err.reason).toBe('blocked_address');
        await c.close();
    });

    it('redirect to localhost, metadata, non-http and disallowed port are refused', async () => {
        const c = client({ 'public.test': ['127.0.0.1'] });
        for (const [to, reason] of [
            [`http://localhost:${h.port}/`, 'blocked_host'],
            ['http://169.254.169.254/latest/meta-data/', 'blocked_address'],
            ['file:///etc/passwd', 'bad_scheme'],
            ['http://public.test:8080/', 'blocked_port'],
        ] as const) {
            const err = await rejectionOf(c.fetch(`http://public.test:${h.port}/redirect?to=${encodeURIComponent(to)}`));
            expect(err.reason, to).toBe(reason);
        }
        await c.close();
    });

    it('public → public redirect chain of 20 hops works (fetch limit)', async () => {
        const c = client({ 'public.test': ['127.0.0.1'] });
        const res = await c.fetch(`http://public.test:${h.port}/chain/20`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('end of chain');
        await c.close();
    });

    it('21 hops fail like fetch does', async () => {
        const c = client({ 'public.test': ['127.0.0.1'] });
        const err = await rejectionOf(c.fetch(`http://public.test:${h.port}/chain/21`));
        expect(err).toBeInstanceOf(TypeError);
        expect(err.message).toBe('fetch failed');
        expect(String(err.cause?.message)).toMatch(/redirect count exceeded/);
        expect(isEgressBlocked(err)).toBe(false);
        await c.close();
    });

    it('method and body follow fetch semantics (302 POST→GET, 303→GET, 307/308 keep)', async () => {
        const c = client({ 'public.test': ['127.0.0.1'] });
        const go = async (status: number) => {
            const to = encodeURIComponent(`http://public.test:${h.port}/echo`);
            const res = await c.fetch(`http://public.test:${h.port}/redirect?status=${status}&to=${to}`, {
                method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' },
            });
            return res.json() as Promise<{ method: string; body: string; contentType: string | null }>;
        };
        for (const s of [301, 302, 303]) expect(await go(s), String(s)).toMatchObject({ method: 'GET', body: '', contentType: null });
        for (const s of [307, 308]) expect(await go(s), String(s)).toMatchObject({ method: 'POST', body: 'payload', contentType: 'text/plain' });
        await c.close();
    });

    it('authorization is dropped on cross-origin redirect, kept on same-origin', async () => {
        const c = client({ 'public.test': ['127.0.0.1'], 'other.test': ['127.0.0.1'] });
        const hdrs = { authorization: 'Bearer secret' };
        const same = await (await c.fetch(`http://public.test:${h.port}/redirect?to=${encodeURIComponent('/echo')}`, { headers: hdrs })).json() as any;
        expect(same.authorization).toBe('Bearer secret');
        const cross = await (await c.fetch(`http://public.test:${h.port}/redirect?to=${encodeURIComponent(`http://other.test:${h.port}/echo`)}`, { headers: hdrs })).json() as any;
        expect(cross.authorization).toBeNull();
        await c.close();
    });

    it("redirect: 'manual' returns the 3xx untouched", async () => {
        const c = client({ 'public.test': ['127.0.0.1'] });
        const res = await c.fetch(`http://public.test:${h.port}/redirect?to=/echo`, { redirect: 'manual' });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/echo');
        await c.close();
    });
});

describe.runIf(haveOpenssl())('1.2-T3a TLS against the local server (SNI, Host, validation unchanged)', () => {
    let tls: TlsMaterial;
    let s: Fixture;
    beforeAll(async () => { tls = makeCert(); s = await startHttps(tls); });
    afterAll(async () => { await s.close(); });

    it('valid cert for the name → loads; Host keeps the name', async () => {
        const c = client({ 'public.test': ['127.0.0.1'] }, { ports: [s.port], connect: { ca: tls.cert } });
        const res = await c.fetch(`https://public.test:${s.port}/echo`);
        expect(res.status).toBe(200);
        expect(((await res.json()) as any).host).toBe(`public.test:${s.port}`);
        await c.close();
    });

    it('untrusted cert → fails (validation not disabled)', async () => {
        const c = client({ 'public.test': ['127.0.0.1'] }, { ports: [s.port] });
        const err = await rejectionOf(c.fetch(`https://public.test:${s.port}/echo`));
        expect(err).toBeInstanceOf(TypeError);
        expect(String(err.cause?.code)).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/);
        await c.close();
    });

    it('name not on the cert → fails (SNI/hostname check uses the original name, not the IP)', async () => {
        const c = client({ 'wrong.test': ['127.0.0.1'] }, { ports: [s.port], connect: { ca: tls.cert } });
        const err = await rejectionOf(c.fetch(`https://wrong.test:${s.port}/echo`));
        expect(String(err.cause?.code)).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
        await c.close();
    });
});

// Real network. Set NET_TESTS=0 to skip (e.g. offline CI); the skip is reported.
describe.runIf(process.env.NET_TESTS !== '0')('1.2-T3 real HTTPS sites through the production safeFetch', () => {
    it('https://example.com loads with a valid certificate', async () => {
        const res = await safeFetch('https://example.com/');
        expect(res.status).toBe(200);
        expect(await res.text()).toMatch(/Example Domain/);
    }, 20000);
    it('https://self-signed.badssl.com is rejected', async () => {
        const err = await rejectionOf(safeFetch('https://self-signed.badssl.com/'));
        expect(err).toBeInstanceOf(TypeError);
    }, 20000);
    it('https://wrong.host.badssl.com is rejected', async () => {
        const err = await rejectionOf(safeFetch('https://wrong.host.badssl.com/'));
        expect(err).toBeInstanceOf(TypeError);
    }, 20000);
    it('http → https redirect on a real site works', async () => {
        const res = await safeFetch('http://github.com/');
        expect(res.status).toBe(200);
        expect(res.url).toMatch(/^https:\/\/github\.com\//);
    }, 20000);
});
