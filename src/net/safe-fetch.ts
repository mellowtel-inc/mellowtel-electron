/**
 * safeFetch: drop-in for fetch() in the job fetch paths that cannot reach
 * private destinations.
 *
 * - Before each hop: precheckUrl (scheme, port, localhost, IP literals).
 * - Host names are resolved inside the connection's own lookup, and every
 *   address is checked there. The socket connects to an address from that
 *   same answer, so there is no gap between check and connect for DNS
 *   rebinding to use. One resolution per new connection.
 * - TLS SNI, certificate hostname check and the Host header keep the original
 *   name; certificate validation is undici's default (unchanged).
 * - Redirects are followed here (max 20, like fetch) so each hop is checked.
 *   Method/body/header rewriting follows the fetch spec.
 *
 * Errors:
 * - Policy refusals throw DestinationBlockedError (code EGRESS_BLOCKED).
 * - DNS failures and other network errors throw TypeError('fetch failed')
 *   with the original cause, exactly like fetch.
 */
import type { LookupAddress, LookupOptions } from 'dns';
import { Agent, Headers, fetch as undiciFetch, type RequestInit, type Response } from 'undici';
import {
    DestinationBlockedError,
    POLICY_REASONS,
    isBlockedAddress,
    precheckUrl,
    resolveAndCheck,
    systemResolver,
    type Resolver,
} from './destination-check';

export type SafeFetchInit = Omit<RequestInit, 'dispatcher'>;

export interface SafeFetchOptions {
    resolver?: Resolver;
    maxRedirects?: number;
    /** Test seams only; production uses the defaults. */
    isBlocked?: (ip: string) => boolean;
    ports?: readonly number[];
    connect?: { ca?: string | string[]; timeout?: number };
}

export interface SafeFetchClient {
    fetch: (input: string | URL, init?: SafeFetchInit) => Promise<Response>;
    close: () => Promise<void>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length'];
const CROSS_ORIGIN_DROP = ['authorization', 'proxy-authorization', 'cookie', 'host'];

/** True when the error is a destination-policy refusal (report as EGRESS_BLOCKED). */
export function isEgressBlocked(err: unknown): err is DestinationBlockedError {
    return err instanceof DestinationBlockedError && POLICY_REASONS.has(err.reason);
}

function fetchFailed(cause: unknown): TypeError {
    const e = new TypeError('fetch failed');
    (e as TypeError & { cause?: unknown }).cause = cause;
    return e;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function makeLookup(resolver: Resolver, isBlocked: (ip: string) => boolean) {
    return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
        resolveAndCheck(hostname, resolver, isBlocked).then(
            (addrs) => {
                const fam = options?.family === 4 || options?.family === 6 ? options.family : 0;
                const list = fam ? addrs.filter((a) => a.family === fam) : addrs;
                if (list.length === 0) {
                    const e: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
                    e.code = 'ENOTFOUND';
                    return callback(e, '');
                }
                if (options?.all) return callback(null, list.map((a) => ({ address: a.address, family: a.family })));
                callback(null, list[0].address, list[0].family);
            },
            (err) => {
                // DNS failures go back as the resolver's own error, like a normal lookup.
                if (err instanceof DestinationBlockedError && !POLICY_REASONS.has(err.reason)) {
                    const cause = (err as Error & { cause?: unknown }).cause;
                    if (cause instanceof Error) return callback(cause as NodeJS.ErrnoException, '');
                    const e: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
                    e.code = 'ENOTFOUND';
                    return callback(e, '');
                }
                callback(err, '');
            },
        );
    };
}

function isReplayableBody(body: unknown): boolean {
    return (
        body == null ||
        typeof body === 'string' ||
        body instanceof ArrayBuffer ||
        ArrayBuffer.isView(body) ||
        body instanceof URLSearchParams ||
        (typeof Blob !== 'undefined' && body instanceof Blob)
    );
}

/** Walks error causes looking for a destination refusal raised inside the connector. */
function findBlock(err: unknown): DestinationBlockedError | undefined {
    let e: unknown = err;
    for (let i = 0; i < 5 && e; i++) {
        if (e instanceof DestinationBlockedError) return e;
        e = (e as { cause?: unknown }).cause;
    }
    return undefined;
}

export function createSafeFetch(opts: SafeFetchOptions = {}): SafeFetchClient {
    const resolver = opts.resolver ?? systemResolver;
    const isBlocked = opts.isBlocked ?? isBlockedAddress;
    const maxRedirects = opts.maxRedirects ?? 20;
    const agent = new Agent({
        connect: {
            ...(opts.connect?.ca ? { ca: opts.connect.ca } : {}),
            ...(opts.connect?.timeout ? { timeout: opts.connect.timeout } : {}),
            lookup: makeLookup(resolver, isBlocked),
        } as any, // undici's connect type omits net's `lookup`, but passes it through to net/tls.connect
    });

    async function safeFetchImpl(input: string | URL, init: SafeFetchInit = {}): Promise<Response> {
        let url: URL;
        try {
            url = new URL(String(input));
        } catch {
            throw new DestinationBlockedError('bad_url', '');
        }
        let method = (init.method ?? 'GET').toUpperCase();
        let body = init.body;
        const headers = new Headers(init.headers as any);
        const mode = init.redirect ?? 'follow';

        for (let hop = 0; ; hop++) {
            precheckUrl(url, 'fetch', { ports: opts.ports });
            let res: Response;
            try {
                res = await undiciFetch(url, { ...init, method, body, headers, redirect: 'manual', dispatcher: agent });
            } catch (err) {
                const block = findBlock(err);
                if (block) throw block;
                throw err;
            }
            if (mode === 'manual' || !REDIRECT_STATUSES.has(res.status)) return res;
            const location = res.headers.get('location');
            if (location === null) return res;
            // Release the connection before the next hop.
            await res.body?.cancel().catch(() => undefined);
            if (mode === 'error') throw fetchFailed(new Error('unexpected redirect'));
            if (hop >= maxRedirects) throw fetchFailed(new Error('redirect count exceeded'));

            let next: URL;
            try {
                next = new URL(location, url);
            } catch {
                throw fetchFailed(new Error('invalid redirect URL'));
            }
            if (next.protocol !== 'http:' && next.protocol !== 'https:') {
                throw new DestinationBlockedError('bad_scheme', next.hostname, next.protocol);
            }
            const s = res.status;
            if (((s === 301 || s === 302) && method === 'POST') || (s === 303 && method !== 'GET' && method !== 'HEAD')) {
                method = 'GET';
                body = undefined;
                for (const h of BODY_HEADERS) headers.delete(h);
            } else if (body != null && !isReplayableBody(body)) {
                throw fetchFailed(new Error('cannot follow redirect with a streamed body'));
            }
            if (next.origin !== url.origin) for (const h of CROSS_ORIGIN_DROP) headers.delete(h);
            url = next;
        }
    }

    return {
        fetch: safeFetchImpl,
        close: () => agent.close(),
    };
}

let defaultClient: SafeFetchClient | undefined;

/** Production safeFetch: system DNS, real rules, one shared keep-alive pool. */
export function safeFetch(input: string | URL, init?: SafeFetchInit): Promise<Response> {
    defaultClient ??= createSafeFetch();
    return defaultClient.fetch(input, init);
}
