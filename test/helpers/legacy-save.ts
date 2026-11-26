/**
 * Reference oracle for the gzip tests: the result-upload request exactly as it was before
 * gzip support (mellowtel-electron 700.0.37). Tests compare what the new code puts on the
 * wire with the flag off against this.
 *
 * - legacySaveCrawlRequest: src/utils/put-to-signed.ts saveCrawl, request building only
 *   (logging, the stubbed info lookup and the response handling removed)
 * - legacyCaptureRequest: src/utils/meucci-helpers.ts collectAndSendCaptures, per-capture POST
 */
import type { DataRequest } from '../../src/utils/data-request';

export interface LegacyRequest {
    endpoint: string;
    init: { method: string; headers: Record<string, string>; body: string };
}

export function legacySaveCrawlRequest(
    datarequest: DataRequest,
    node_identifier: string,
    content: string,
    markDown: string | undefined,
    BATCH_execution: boolean,
    batch_id: string,
    website_unreachable: boolean = false,
    cereal_result: any = {},
    file_name_bytes: string = '',
    cereal_success: boolean = true
): LegacyRequest {
    let endpoint: string = 'https://request.mellow.tel/';
    if (datarequest.save_html_endpoint) {
        endpoint = datarequest.save_html_endpoint;
    }
    const moreInfo: any = { statusCode: 200 };

    const bodyData: any = {
        recordID: datarequest.recordID,
        fastLane: datarequest.fastLane,
        url: datarequest.url,
        htmlTransformer: datarequest.htmlTransformer,
        orgId: datarequest.orgId,
        saveText: datarequest.saveText,
        node_identifier: node_identifier,
        BATCH_execution: BATCH_execution,
        batch_id: batch_id,
        final_url: datarequest.finalUrl || datarequest.url,
        website_unreachable: website_unreachable,
        statusCode: moreInfo.statusCode,
        requestMessageInfo: datarequest.json,
        saveHtml: datarequest.saveHtml,
        saveMarkdown: datarequest.saveMarkdown,
        cereal_result: JSON.stringify({ data: cereal_result, success: cereal_success }),
        file_name_bytes: file_name_bytes,
        actionResults: datarequest.actionResults || [],
        actionsFailed: (datarequest.actionResults || []).some((r) => r.status === 'failed' || r.status === 'timeout'),
    };

    if (datarequest.parser_job) {
        bodyData['json'] = JSON.stringify(cereal_result);
    } else {
        if (datarequest.saveHtml) {
            bodyData['content'] = content;
        }
        if (datarequest.saveMarkdown) {
            bodyData['markDown'] = markDown;
        }
    }

    return {
        endpoint,
        init: { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(bodyData) },
    };
}

export function legacyCaptureRequest(endpoint: string, capture: unknown): LegacyRequest {
    return {
        endpoint,
        init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(capture) },
    };
}
