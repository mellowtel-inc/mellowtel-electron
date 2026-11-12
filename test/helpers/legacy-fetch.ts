/**
 * Reference oracle for the job-fetch tests: the job fetch code exactly as it was before
 * the destination check (mellowtel-electron 700.0.36), using the runtime's
 * built-in fetch. Tests compare the new paths against this.
 *
 * - legacyParserFetch: body of the `parser_job` branch, src/websockets.ts:400-420
 * - legacyMakeFetchRequest: src/utils/data-helpers.ts:14-61 (logging removed)
 */
import { ObservedError } from '../../src/observability/observed-error';
import type { DataRequest } from '../../src/utils/data-request';

export async function legacyParserFetch(url: string): Promise<{ html: string; markdown: string }> {
    try {
        const response = await fetch(url);
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
        throw new ObservedError(`[parser_fetch] Error fetching ${url} - ${error}`, {
            code: 'PARSER_FETCH_FAILED',
            stage: 'parser_fetch',
            raw: { url, error: String(error) },
            cause: error,
        });
    }
}

export async function legacyMakeFetchRequest(dataRequest: DataRequest): Promise<{ contentType: string | null; content: Buffer }> {
    const { method_endpoint, method, method_payload, method_headers } = dataRequest;
    const options: RequestInit = { method: method, headers: method_headers };
    if (method_payload && method_payload !== 'no_payload') {
        options.body = method_payload;
    }
    try {
        const response = await fetch(method_endpoint, options);
        const contentType = response.headers.get('content-type');
        const content = await response.arrayBuffer();
        if (!response.ok) {
            const bodyPreview = Buffer.from(content).toString('utf-8').slice(0, 2000);
            throw new ObservedError(`[makeFetchRequest] HTTP ${response.status} for ${method_endpoint}`, {
                code: 'FETCH_FAILED',
                stage: 'fetch',
                raw: { method, method_endpoint, status: response.status, statusText: response.statusText, body: bodyPreview },
            });
        }
        return { contentType, content: Buffer.from(content) };
    } catch (error) {
        if (error instanceof ObservedError) {
            throw error;
        }
        throw new ObservedError(`[makeFetchRequest]: Error fetching ${method_endpoint} - ${error}`, {
            code: 'FETCH_FAILED',
            stage: 'fetch',
            raw: { method, method_endpoint, error: String(error) },
            cause: error,
        });
    }
}
