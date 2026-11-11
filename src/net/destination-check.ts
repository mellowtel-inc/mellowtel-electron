/**
 * Destination check: decides whether this device may open a connection to a
 * host and port. Used by the job fetch paths (mode "fetch": ports 80 and 443).
 * Mode "tls" allows port 443 only, for callers that only ever need HTTPS.
 *
 * Rules:
 * - Every address the host resolves to must be public. One private address
 *   is enough to refuse (a host that resolves to both is a rebinding risk).
 * - IP literals are normalised with the WHATWG URL host parser first, so
 *   decimal (2130706433), hex (0x7f000001), octal (0177.0.0.1) and short
 *   (127.1) forms are caught, plus IPv4 embedded in IPv6 (mapped, NAT64, 6to4).
 * - The port must be on the mode's allow-list.
 * - The caller must connect to `address` (the one that was checked), never
 *   re-resolve the name. See safe-fetch.ts for how fetch does that.
 *
 * Privacy: error messages carry the host name and a reason, never the
 * resolved address.
 */
import { promises as dns } from 'dns';
import { isIP } from 'net';

export type EgressMode = 'fetch' | 'tls';

export const ALLOWED_PORTS: Readonly<Record<EgressMode, readonly number[]>> = Object.freeze({
    fetch: Object.freeze([80, 443]),
    tls: Object.freeze([443]),
});

export type BlockReason =
    | 'bad_url'
    | 'bad_scheme'
    | 'blocked_port'
    | 'blocked_host'
    | 'blocked_address'
    | 'dns_failed'
    | 'no_address';

/**
 * Reasons that mean "the destination itself is not allowed". dns_failed and
 * no_address are lookup failures, not policy refusals: the fetch path reports
 * them like an ordinary network error so EGRESS_BLOCKED stays a clean signal.
 */
export const POLICY_REASONS: ReadonlySet<BlockReason> = new Set<BlockReason>([
    'bad_url', 'bad_scheme', 'blocked_port', 'blocked_host', 'blocked_address',
]);

export class DestinationBlockedError extends Error {
    readonly code = 'EGRESS_BLOCKED' as const;
    readonly reason: BlockReason;
    readonly host: string;

    constructor(reason: BlockReason, host: string, detail?: string, cause?: unknown) {
        super(`[EGRESS_BLOCKED] ${reason}: ${host || '(empty host)'}${detail ? ` (${detail})` : ''}`);
        this.name = 'DestinationBlockedError';
        this.reason = reason;
        this.host = host;
        if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
    }
}

export interface ResolvedAddress {
    address: string;
    family: number;
}

/** Resolves a host name to every A and AAAA address. Injectable for tests. */
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;

/** Same resolver net.connect uses (getaddrinfo, honours /etc/hosts), all families. */
export const systemResolver: Resolver = async (host) => {
    const res = await dns.lookup(host, { all: true, verbatim: true });
    return res.map((r) => ({ address: r.address, family: r.family }));
};

export interface CheckOptions {
    mode: EgressMode;
    resolver?: Resolver;
}

/**
 * Test seams only. Production callers never pass these; the defaults are the
 * real rules. `ports` replaces the mode's port list; `isBlocked` replaces the
 * address rule for resolved (non-literal) hosts.
 */
export interface PolicyOverrides {
    ports?: readonly number[];
    isBlocked?: (ip: string) => boolean;
}

export interface CheckedDestination {
    /** Host name as the caller should send it (SNI / Host header). IPv6 without brackets. */
    host: string;
    port: number;
    /** The checked address to connect to. */
    address: string;
    family: number;
    /** Every address the host resolved to; all of them passed the check. */
    addresses: ResolvedAddress[];
}

// ---------------------------------------------------------------------------
// Blocked ranges
// ---------------------------------------------------------------------------

type V4Range = [base: number, bits: number];
type V6Range = [base: bigint, bits: number];

function v4(s: string): number {
    const p = s.split('.').map(Number);
    return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

const V4_BLOCKED: V4Range[] = [
    ['0.0.0.0', 8],         // "this network", includes 0.0.0.0
    ['10.0.0.0', 8],        // RFC 1918
    ['100.64.0.0', 10],     // CGNAT (RFC 6598)
    ['127.0.0.0', 8],       // loopback
    ['169.254.0.0', 16],    // link-local, includes cloud metadata 169.254.169.254
    ['172.16.0.0', 12],     // RFC 1918
    ['192.0.0.0', 24],      // IETF protocol assignments
    ['192.0.2.0', 24],      // TEST-NET-1
    ['192.168.0.0', 16],    // RFC 1918
    ['198.18.0.0', 15],     // benchmarking
    ['198.51.100.0', 24],   // TEST-NET-2
    ['203.0.113.0', 24],    // TEST-NET-3
    ['224.0.0.0', 4],       // multicast
    ['240.0.0.0', 4],       // reserved, includes 255.255.255.255
].map(([a, b]) => [v4(a as string), b as number]);

const V6_BLOCKED: V6Range[] = [
    ['::', 96],             // unspecified, loopback, deprecated IPv4-compatible
    ['64:ff9b:1::', 48],    // local-use NAT64
    ['100::', 64],          // discard
    ['2001::', 32],         // Teredo
    ['2001:db8::', 32],     // documentation
    ['fc00::', 7],          // unique local (ULA)
    ['fe80::', 10],         // link-local
    ['fec0::', 10],         // deprecated site-local
    ['ff00::', 8],          // multicast
].map(([a, b]) => [v6ToBigInt(expandV6(a as string)!), b as number]);

function inV4(n: number, [base, bits]: V4Range): boolean {
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
}

function inV6(n: bigint, [base, bits]: V6Range): boolean {
    const shift = BigInt(128 - bits);
    return n >> shift === base >> shift;
}

/** Expands an IPv6 literal (no brackets, no zone) to 8 hextets, or null if invalid. */
function expandV6(ip: string): number[] | null {
    let s = ip.toLowerCase();
    // Rewrite a dotted IPv4 tail (::ffff:10.0.0.1) as two hextets (::ffff:a00:1).
    const lastColon = s.lastIndexOf(':');
    const tail = s.slice(lastColon + 1);
    if (tail.includes('.')) {
        if (isIP(tail) !== 4) return null;
        const n = v4(tail);
        s = `${s.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
    }
    const parts = s.split('::');
    if (parts.length > 2) return null;
    const head = parts[0] ? parts[0].split(':') : [];
    const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
    let groups: string[];
    if (parts.length === 2) {
        const fill = 8 - head.length - rest.length;
        if (fill < 1) return null;
        groups = [...head, ...Array(fill).fill('0'), ...rest];
    } else {
        groups = head;
    }
    if (groups.length !== 8) return null;
    const out: number[] = [];
    for (const g of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
    }
    return out;
}

function v6ToBigInt(h: number[]): bigint {
    return h.reduce((acc, x) => (acc << 16n) | BigInt(x), 0n);
}

function isBlockedV4(n: number): boolean {
    return V4_BLOCKED.some((r) => inV4(n, r));
}

/**
 * True if connecting to this IP literal must be refused. Anything that is not
 * a valid IPv4 or IPv6 literal is treated as blocked (fail closed).
 */
export function isBlockedAddress(ip: string): boolean {
    const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
    const fam = isIP(bare);
    if (fam === 4) return isBlockedV4(v4(bare));
    if (fam !== 6) return true;
    if (bare.includes('%')) return true; // zone ids only make sense for link-local
    const h = expandV6(bare);
    if (!h) return true;
    const n = v6ToBigInt(h);
    if (V6_BLOCKED.some((r) => inV6(n, r))) return true;
    const embedded = embeddedV4(h);
    if (embedded !== null && isBlockedV4(embedded)) return true;
    return false;
}

/** IPv4 address carried inside an IPv6 one (mapped, NAT64, 6to4), if any. */
function embeddedV4(h: number[]): number | null {
    const zeros = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
    // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (translated)
    if (zeros(0, 5) && h[5] === 0xffff) return ((h[6] << 16) | h[7]) >>> 0;
    if (zeros(0, 4) && h[4] === 0xffff && h[5] === 0) return ((h[6] << 16) | h[7]) >>> 0;
    // 64:ff9b::a.b.c.d (well-known NAT64 prefix)
    if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return ((h[6] << 16) | h[7]) >>> 0;
    // 2002:aabb:ccdd::/48 (6to4)
    if (h[0] === 0x2002) return ((h[1] << 16) | h[2]) >>> 0;
    return null;
}

// ---------------------------------------------------------------------------
// Host and URL parsing
// ---------------------------------------------------------------------------

function isLocalhostName(host: string): boolean {
    const h = host.replace(/\.$/, '');
    return h === 'localhost' || h.endsWith('.localhost');
}

interface ParsedTarget {
    host: string;      // no brackets
    port: number;
    literal: boolean;  // host is an IP literal
}

function stripBrackets(h: string): string {
    return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function parseUrlTarget(input: string | URL, mode: EgressMode, ports?: readonly number[]): ParsedTarget {
    let url: URL;
    try {
        url = typeof input === 'string' ? new URL(input) : new URL(input.href);
    } catch {
        throw new DestinationBlockedError('bad_url', '');
    }
    const host = stripBrackets(url.hostname);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new DestinationBlockedError('bad_scheme', host, url.protocol);
    }
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    return finishTarget(host, port, mode, ports);
}

function finishTarget(host: string, port: number, mode: EgressMode, ports?: readonly number[]): ParsedTarget {
    if (!host) throw new DestinationBlockedError('bad_url', '');
    if (!(ports ?? ALLOWED_PORTS[mode]).includes(port)) {
        throw new DestinationBlockedError('blocked_port', host, `port ${port}`);
    }
    if (isLocalhostName(host)) throw new DestinationBlockedError('blocked_host', host);
    const literal = isIP(host) !== 0;
    if (literal && isBlockedAddress(host)) throw new DestinationBlockedError('blocked_address', host);
    return { host, port, literal };
}

/** Normalises a bare host through the same URL host parser. */
function parseHostPortTarget(host: string, port: number, mode: EgressMode): ParsedTarget {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new DestinationBlockedError('blocked_port', host, `port ${port}`);
    }
    const raw = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    let url: URL;
    try {
        url = new URL(`http://${raw}/`);
    } catch {
        throw new DestinationBlockedError('bad_url', host);
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) {
        throw new DestinationBlockedError('bad_url', host);
    }
    return finishTarget(stripBrackets(url.hostname), port, mode);
}

/**
 * Synchronous pre-check of a URL: scheme, port, localhost names and IP
 * literals. Host names still need resolveAndCheck() before connecting.
 */
export function precheckUrl(
    input: string | URL,
    mode: EgressMode,
    overrides: Pick<PolicyOverrides, 'ports'> = {},
): { host: string; port: number; literal: boolean } {
    return parseUrlTarget(input, mode, overrides.ports);
}

/**
 * Resolves a host name and checks every address. Returns the addresses in
 * resolver order; the first one is the one to connect to.
 */
export async function resolveAndCheck(
    host: string,
    resolver: Resolver = systemResolver,
    isBlocked: (ip: string) => boolean = isBlockedAddress,
): Promise<ResolvedAddress[]> {
    if (isIP(host)) {
        if (isBlockedAddress(host)) throw new DestinationBlockedError('blocked_address', host);
        return [{ address: host, family: isIP(host) }];
    }
    if (isLocalhostName(host)) throw new DestinationBlockedError('blocked_host', host);
    let addrs: ResolvedAddress[];
    try {
        addrs = await resolver(host);
    } catch (e) {
        const code = (e as { code?: string })?.code;
        throw new DestinationBlockedError('dns_failed', host, code, e);
    }
    if (!addrs || addrs.length === 0) throw new DestinationBlockedError('no_address', host);
    for (const a of addrs) {
        if (isBlocked(a.address)) throw new DestinationBlockedError('blocked_address', host);
    }
    return addrs.map((a) => ({ address: a.address, family: a.family || isIP(a.address) }));
}

async function complete(t: ParsedTarget, resolver: Resolver | undefined): Promise<CheckedDestination> {
    const addresses = t.literal ? [{ address: t.host, family: isIP(t.host) }] : await resolveAndCheck(t.host, resolver);
    return { host: t.host, port: t.port, address: addresses[0].address, family: addresses[0].family, addresses };
}

/** Full check of a URL (fetch paths). */
export async function checkDestination(input: string | URL, opts: CheckOptions): Promise<CheckedDestination> {
    return complete(parseUrlTarget(input, opts.mode), opts.resolver);
}

/** Full check of a bare host + port (no URL). */
export async function checkHostPort(host: string, port: number, opts: CheckOptions): Promise<CheckedDestination> {
    return complete(parseHostPortTarget(host, port, opts.mode), opts.resolver);
}
