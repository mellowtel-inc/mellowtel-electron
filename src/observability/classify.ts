import { DataRequest } from '../utils/data-request';
import { ObservedError, errorMessage } from './observed-error';
import { JobErrorCode, JobRequestType } from './types';

export function classifyRequestType(dataRequest: DataRequest): JobRequestType {
    if (dataRequest.parser_job) {
        return 'parser';
    }
    if (dataRequest.method_endpoint) {
        return dataRequest.saveFile ? 'fetch_file' : 'fetch';
    }
    return 'scrape';
}

export function jobUsesCereal(dataRequest: DataRequest): boolean {
    try {
        return Boolean(JSON.parse(dataRequest.cerealObject || '{}').useCereal);
    } catch {
        return false;
    }
}

export function classifyError(error: unknown, fallbackStage: string): { code: JobErrorCode; stage: string } {
    if (error instanceof ObservedError) {
        return { code: error.code, stage: error.stage || fallbackStage };
    }

    const message = errorMessage(error);

    if (/RATE LIMIT/i.test(message)) {
        return { code: 'RATE_LIMIT', stage: 'rate_limit' };
    }
    if (/Cereal process timed out/i.test(message) || (/timed out/i.test(message) && /cereal/i.test(message))) {
        return { code: 'CEREAL_TIMEOUT', stage: 'cereal' };
    }
    if (/\[CerealManager\]/i.test(message) || (/cereal/i.test(message) && /fail|error|discard/i.test(message))) {
        return { code: 'CEREAL_FAILED', stage: 'cereal' };
    }
    if (/\[WindowPool\] Timeout/i.test(message)) {
        return { code: 'WINDOW_ACQUIRE_TIMEOUT', stage: 'window_pool' };
    }
    if (/\[WindowPool\]/i.test(message)) {
        return { code: 'WINDOW_POOL_FAILED', stage: 'window_pool' };
    }
    if (/\[processHtmlContent\] Timeout/i.test(message)) {
        return { code: 'HTML_PROCESS_TIMEOUT', stage: 'process_html' };
    }
    if (/\[processUrl\] Timeout/i.test(message) || /Processing timed out/i.test(message)) {
        return { code: 'SCRAPE_TIMEOUT', stage: 'scrape' };
    }
    if (/Failed to load URL/i.test(message)) {
        return { code: 'NAVIGATION_FAILED', stage: 'scrape' };
    }
    if (/\[saveCrawl\]/i.test(message) || /Error in saveCrawl/i.test(message)) {
        return { code: 'SAVE_CRAWL_FAILED', stage: 'save_crawl' };
    }
    if (/\[getS3SignedUrls\]/i.test(message)) {
        return { code: 'S3_SIGN_FAILED', stage: 's3' };
    }
    if (/\[uploadToS3\]|S3 upload failed/i.test(message)) {
        return { code: 'S3_UPLOAD_FAILED', stage: 's3' };
    }
    if (/\[makeFetchRequest\]/i.test(message) || /Error fetching/i.test(message)) {
        return { code: fallbackStage === 'parser_fetch' ? 'PARSER_FETCH_FAILED' : 'FETCH_FAILED', stage: fallbackStage === 'parser_fetch' ? 'parser_fetch' : 'fetch' };
    }
    if (/\[Jar\]/i.test(message)) {
        return { code: 'JAR_FAILED', stage: 'jar' };
    }
    if (/shut down/i.test(message)) {
        return { code: 'NODE_SHUTDOWN', stage: fallbackStage };
    }
    if (/timeout|timed out/i.test(message)) {
        return { code: 'JOB_TIMEOUT', stage: fallbackStage };
    }
    if (/\[processUrl\]/i.test(message)) {
        return { code: 'SCRAPE_FAILED', stage: 'scrape' };
    }
    return { code: 'JOB_FAILED', stage: fallbackStage };
}
