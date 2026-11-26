import { describe, it, expect } from 'vitest';
import {
    checkDestination,
    checkHostPort,
    isBlockedAddress,
    DestinationBlockedError,
    type Resolver,
} from '../../src/net/destination-check';

// Resolver stubs: unit tests never touch real DNS.
const resolveTo = (...addrs: string[]): Resolver => async () =>
    addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const mustNotResolve: Resolver = async (host) => {
    throw new Error(`resolver must not be called for literal host ${host}`);
};

async function expectBlocked(p: Promise<unknown>, reason?: string): Promise<DestinationBlockedError> {
    const err = await p.then(
        () => { throw new Error('expected EGRESS_BLOCKED, got allowed'); },
        (e) => e,
    );
    expect(err).toBeInstanceOf(DestinationBlockedError);
    expect(err.code).toBe('EGRESS_BLOCKED');
    if (reason) expect(err.reason).toBe(reason);
    return err;
}

const urlFor = (host: string) => `https://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}/`;

describe('1.1-T1 private, loopback, link-local, CGNAT, unspecified and ULA literals are refused', () => {
    const cases = [
        '10.0.0.1', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254',
        '100.64.0.1', '::1', 'fe80::1', 'fc00::1', '0.0.0.0',
    ];
    for (const ip of cases) {
        it(`${ip} literal in URL is refused`, async () => {
            await expectBlocked(checkDestination(urlFor(ip), { mode: 'fetch', resolver: mustNotResolve }), 'blocked_address');
        });
        it(`${ip} returned by DNS is refused`, async () => {
            await expectBlocked(checkDestination('https://example.test/', { mode: 'fetch', resolver: resolveTo(ip) }), 'blocked_address');
        });
        it(`isBlockedAddress(${ip}) is true`, () => {
            expect(isBlockedAddress(ip)).toBe(true);
        });
    }
});

describe('1.1-T2 encoded and mapped forms are refused', () => {
    for (const host of ['[::ffff:10.0.0.1]', '2130706433', '0x7f000001', '0177.0.0.1', '127.1', 'localhost', 'LOCALHOST', 'foo.localhost']) {
        it(`${host} is refused`, async () => {
            await expectBlocked(checkDestination(`http://${host}/`, { mode: 'fetch', resolver: mustNotResolve }));
        });
    }
    for (const host of ['localhost', 'LOCALHOST', 'foo.localhost', 'localhost.']) {
        it(`${host} is refused by name, before any DNS lookup`, async () => {
            await expectBlocked(checkDestination(`http://${host}/`, { mode: 'fetch', resolver: resolveTo('93.184.215.14') }), 'blocked_host');
        });
    }
    it('IPv4-mapped IPv6 returned by DNS is refused', async () => {
        await expectBlocked(checkDestination('https://example.test/', { mode: 'fetch', resolver: resolveTo('::ffff:192.168.0.1') }), 'blocked_address');
    });
});

describe('1.1-T3 public destinations are allowed and the checked address is returned', () => {
    it('172.32.0.1 (just outside 172.16/12) is allowed', async () => {
        const r = await checkDestination('https://172.32.0.1/', { mode: 'fetch', resolver: mustNotResolve });
        expect(r.address).toBe('172.32.0.1');
        expect(r.family).toBe(4);
        expect(r.port).toBe(443);
    });
    it('1.1.1.1 is allowed', async () => {
        const r = await checkDestination('http://1.1.1.1/', { mode: 'fetch', resolver: mustNotResolve });
        expect(r).toMatchObject({ address: '1.1.1.1', port: 80, host: '1.1.1.1' });
    });
    it('public hostname is allowed; returns the exact resolved address', async () => {
        const r = await checkDestination('https://example.com/path?q=1', { mode: 'fetch', resolver: resolveTo('93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c') });
        expect(r.host).toBe('example.com');
        expect(r.address).toBe('93.184.215.14');
        expect(r.addresses.map((a) => a.address)).toEqual(['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c']);
    });
});

describe('1.1-T4 a host with any private address is refused', () => {
    it('one public + one private', async () => {
        await expectBlocked(checkDestination('https://mixed.test/', { mode: 'fetch', resolver: resolveTo('93.184.215.14', '10.1.2.3') }), 'blocked_address');
    });
    it('private first then public', async () => {
        await expectBlocked(checkDestination('https://mixed.test/', { mode: 'fetch', resolver: resolveTo('fd00::5', '93.184.215.14') }), 'blocked_address');
    });
    it('empty DNS answer is refused', async () => {
        await expectBlocked(checkDestination('https://empty.test/', { mode: 'fetch', resolver: resolveTo() }), 'no_address');
    });
    it('DNS failure is refused, not thrown raw', async () => {
        const failing: Resolver = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); };
        await expectBlocked(checkDestination('https://nx.test/', { mode: 'fetch', resolver: failing }), 'dns_failed');
    });
});

describe('1.1-T5 port allow-list per mode', () => {
    it('tls mode refuses 8080', async () => {
        await expectBlocked(checkHostPort('example.com', 8080, { mode: 'tls', resolver: mustNotResolve }), 'blocked_port');
    });
    it('tls mode refuses 80', async () => {
        await expectBlocked(checkHostPort('example.com', 80, { mode: 'tls', resolver: mustNotResolve }), 'blocked_port');
    });
    it('tls mode allows 443', async () => {
        const r = await checkHostPort('example.com', 443, { mode: 'tls', resolver: resolveTo('93.184.215.14') });
        expect(r.address).toBe('93.184.215.14');
    });
    it('fetch mode refuses 8080 and allows 80/443', async () => {
        await expectBlocked(checkDestination('http://example.com:8080/', { mode: 'fetch', resolver: mustNotResolve }), 'blocked_port');
        await expect(checkDestination('http://example.com/', { mode: 'fetch', resolver: resolveTo('93.184.215.14') })).resolves.toMatchObject({ port: 80 });
        await expect(checkDestination('https://example.com:443/', { mode: 'fetch', resolver: resolveTo('93.184.215.14') })).resolves.toMatchObject({ port: 443 });
    });
    it('fetch mode refuses non-http schemes', async () => {
        for (const u of ['file:///etc/passwd', 'ftp://example.com/', 'data:text/plain,hi', 'ws://example.com/']) {
            await expectBlocked(checkDestination(u, { mode: 'fetch', resolver: mustNotResolve }), 'bad_scheme');
        }
    });
    it('unparseable URL is refused', async () => {
        await expectBlocked(checkDestination('not a url', { mode: 'fetch', resolver: mustNotResolve }), 'bad_url');
    });
    it('tls mode accepts IPv6 host without brackets', async () => {
        await expectBlocked(checkHostPort('fe80::1', 443, { mode: 'tls', resolver: mustNotResolve }), 'blocked_address');
    });
});

describe('privacy: refusal messages never contain the resolved address', () => {
    it('blocked DNS answer is not echoed', async () => {
        const err = await expectBlocked(checkDestination('https://rebind.test/', { mode: 'fetch', resolver: resolveTo('10.9.8.7') }));
        expect(err.message).not.toContain('10.9.8.7');
        expect(JSON.stringify(err)).not.toContain('10.9.8.7');
        expect(err.message).toContain('rebind.test');
    });
});

// ---------------------------------------------------------------------------
// 1.1-T6 Fuzz (added): generated encodings of blocked addresses. Seeded so a
// failure is reproducible; the seed is printed in the test name.
// ---------------------------------------------------------------------------
function rng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const SEED = 20261111;
const rand = rng(SEED);
const ri = (n: number) => Math.floor(rand() * n);
const pick = <T>(xs: T[]) => xs[ri(xs.length)];

const V4_BLOCKED: Array<[number, number]> = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
    [0xac100000, 12], [0xc0a80000, 16], [0xe0000000, 4], [0xf0000000, 4], [0xc6120000, 15],
];
function randomBlockedV4(): number {
    const [base, bits] = pick(V4_BLOCKED);
    const hostBits = 32 - bits;
    const host = hostBits === 0 ? 0 : Math.floor(rand() * 2 ** hostBits);
    return (base + host) >>> 0;
}
function randomPublicV4(): number {
    // 1.0.0.0 – 9.255.255.255 and 11.0.0.0 – 99.255.255.255: never blocked.
    return pick([() => 0x01000000 + ri(0x09000000), () => 0x0b000000 + ri(0x59000000)])() >>> 0;
}
const octets = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function encodeV4(n: number): string {
    const o = octets(n);
    switch (ri(8)) {
        case 0: return o.join('.');
        case 1: return String(n);
        case 2: return '0x' + n.toString(16);
        case 3: return o.map((x) => '0' + x.toString(8)).join('.');
        case 4: return o.map((x) => '0x' + x.toString(16).toUpperCase()).join('.');
        case 5: return `${o[0]}.${o[1]}.${(o[2] << 8) | o[3]}`;
        case 6: return `${o[0]}.${(o[1] << 16) | (o[2] << 8) | o[3]}`;
        default: return `[::ffff:${o.join('.')}]`;
    }
}
const hex4 = (n: number) => n.toString(16);
function embedV4inV6(n: number): string {
    const hi = hex4(n >>> 16), lo = hex4(n & 0xffff);
    switch (ri(4)) {
        case 0: return `[::ffff:${hi}:${lo}]`;
        case 1: return `[0:0:0:0:0:FFFF:${hi.toUpperCase()}:${lo}]`;
        case 2: return `[64:ff9b::${hi}:${lo}]`;
        default: return `[2002:${hi}:${lo}::1]`;
    }
}
function randomBlockedV6(): string {
    const r = () => hex4(ri(0x10000));
    switch (ri(6)) {
        case 0: return `[fd${hex4(ri(256)).padStart(2, '0')}:${r()}::${r()}]`;
        case 1: return `[FC00:${r()}:${r()}::${r()}]`;
        case 2: return `[fe${pick(['8', '9', 'a', 'b'])}${hex4(ri(16))}::${r()}]`;
        case 3: return `[ff0${hex4(ri(16))}::${r()}]`;
        case 4: return '[0:0:0:0:0:0:0:1]';
        default: return `[2001:db8:${r()}::${r()}]`;
    }
}

describe(`1.1-T6 fuzz (seed ${SEED})`, () => {
    it('2,000 encoded blocked IPv4 literals are all refused', async () => {
        for (let i = 0; i < 2000; i++) {
            const host = encodeV4(randomBlockedV4());
            await expectBlocked(checkDestination(`http://${host}/`, { mode: 'fetch', resolver: mustNotResolve })).catch((e) => {
                throw new Error(`not refused: ${host}: ${e.message}`);
            });
        }
    });
    it('1,000 IPv6-embedded blocked IPv4 literals are all refused', async () => {
        for (let i = 0; i < 1000; i++) {
            const host = embedV4inV6(randomBlockedV4());
            await expectBlocked(checkDestination(`https://${host}/`, { mode: 'fetch', resolver: mustNotResolve })).catch((e) => {
                throw new Error(`not refused: ${host}: ${e.message}`);
            });
        }
    });
    it('1,000 blocked IPv6 literals are all refused', async () => {
        for (let i = 0; i < 1000; i++) {
            const host = randomBlockedV6();
            await expectBlocked(checkDestination(`https://${host}/`, { mode: 'fetch', resolver: mustNotResolve })).catch((e) => {
                throw new Error(`not refused: ${host}: ${e.message}`);
            });
        }
    });
    it('1,000 encoded public IPv4 literals are all allowed (no false positives)', async () => {
        for (let i = 0; i < 1000; i++) {
            const n = randomPublicV4();
            const host = encodeV4(n);
            const r = await checkDestination(`http://${host}/`, { mode: 'fetch', resolver: mustNotResolve });
            const expected = octets(n).join('.');
            expect(r.address === expected || r.address === `::ffff:${hex4(n >>> 16)}:${hex4(n & 0xffff)}`, `${host} → ${r.address}`).toBe(true);
        }
    });
    it('garbage input never crashes, only refuses or allows', async () => {
        const chars = 'abcdef0123456789:.[]%-x/@ ';
        for (let i = 0; i < 2000; i++) {
            let s = '';
            const len = 1 + ri(30);
            for (let j = 0; j < len; j++) s += chars[ri(chars.length)];
            try {
                await checkDestination(`http://${s}/`, { mode: 'fetch', resolver: resolveTo('10.0.0.1') });
            } catch (e) {
                expect(e, `input ${JSON.stringify(s)}`).toBeInstanceOf(DestinationBlockedError);
            }
        }
    });
});
