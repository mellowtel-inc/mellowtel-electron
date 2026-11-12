/**
 * The two job paths that fetch a URL directly from the device:
 * - parser_job        → fetchParserContent (was inline in websockets.ts)
 * - method_endpoint   → makeFetchRequest   (was in data-helpers.ts, re-exported there)
 *
 * Both go through safeFetch, so private destinations are refused before any
 * socket is opened and reported as EGRESS_BLOCKED. Everything else (output,
 * error codes, error shapes) is unchanged from the previous fetch() version.
 */
import { Logger } from '../logger/logger';
import { ObservedError } from '../observability/observed-error';
import { currentJobTrace } from '../observability/trace';
import { isEgressBlocked, safeFetch, type SafeFetchInit } from '../net/safe-fetch';
import type { DataRequest } from './data-request';

/** Injectable for tests only; production always uses safeFetch. */
type FetchImpl = (input: string, init?: SafeFetchInit) => Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
}>;

function egressError(stage: string, message: string, error: { reason: string; host: string }, extra: Record<string, unknown>) {
    // raw carries reason + host only; never the resolved address.
    return new ObservedError(message, {
        code: 'EGRESS_BLOCKED',
        stage,
        raw: { ...extra, reason: error.reason, host: error.host },
        cause: error,
    });
}

export async function fetchParserContent(url: string, fetchImpl: FetchImpl = safeFetch): Promise<{ html: string; markdown: string }> {
    try {
        const response = await fetchImpl(url);
        const content = await response.text();
        if (!response.ok) {
            throw new ObservedError(`[parser_fetch] HTTP ${response.status} for ${url}`, {
                code: 'PARSER_FETCH_FAILED',
                stage: 'parser_fetch',
                raw: { status: response.status, statusText: response.statusText, body: content },
            });
        }
        return { html: content, markdown: '' };
    } catch (error) {
        if (error instanceof ObservedError) {
            throw error;
        }
        if (isEgressBlocked(error)) {
            throw egressError('parser_fetch', `[parser_fetch] ${error.message}`, error, { url });
        }
        throw new ObservedError(`[parser_fetch] Error fetching ${url} - ${error}`, {
            code: 'PARSER_FETCH_FAILED',
            stage: 'parser_fetch',
            raw: { url, error: String(error) },
            cause: error,
        });
    }
}

export async function makeFetchRequest(
    dataRequest: DataRequest,
    fetchImpl: FetchImpl = safeFetch,
): Promise<{ contentType: string | null, content: Buffer }> {
    const { method_endpoint, method, method_payload, method_headers } = dataRequest;

    const options: SafeFetchInit = {
        method: method,
        headers: method_headers
    };

    if (method_payload && method_payload !== 'no_payload') {
        options.body = method_payload;
    }

    try {
        const response = await fetchImpl(method_endpoint, options);
        const contentType = response.headers.get('content-type');
        const content = await response.arrayBuffer();
        currentJobTrace()?.add('info', `[makeFetchRequest] ${response.status} ${method_endpoint}`, {
            status: response.status,
            statusText: response.statusText,
            contentType,
            bytes: content.byteLength,
        });
        if (!response.ok) {
            const bodyPreview = Buffer.from(content).toString('utf-8').slice(0, 2000);
            throw new ObservedError(`[makeFetchRequest] HTTP ${response.status} for ${method_endpoint}`, {
                code: 'FETCH_FAILED',
                stage: 'fetch',
                raw: {
                    method,
                    method_endpoint,
                    status: response.status,
                    statusText: response.statusText,
                    body: bodyPreview,
                },
            });
        }
        return { contentType, content: Buffer.from(content) };
    } catch (error) {
        Logger.error(`[makeFetchRequest]: Error fetching ${method_endpoint} - ${error}`);
        if (error instanceof ObservedError) {
            throw error;
        }
        if (isEgressBlocked(error)) {
            throw egressError('fetch', `[makeFetchRequest] ${error.message}`, error, { method, method_endpoint });
        }
        throw new ObservedError(`[makeFetchRequest]: Error fetching ${method_endpoint} - ${error}`, {
            code: 'FETCH_FAILED',
            stage: 'fetch',
            raw: { method, method_endpoint, error: String(error) },
            cause: error,
        });
    }
}
