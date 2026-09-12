import os from 'os';
import { VERSION } from '../constants';
import { Logger } from '../logger/logger';
import { getIdentifier } from '../utils/identity-helpers';
import { DataRequest } from '../utils/data-request';
import { classifyError, classifyRequestType, jobUsesCereal } from './classify';
import { ObservedError, errorMessage, errorName, errorStack } from './observed-error';
import { serializeRaw } from './serialize';
import { currentJobTrace } from './trace';
import { JobErrorReport, JobErrorSeverity } from './types';

const REPORT_TIMEOUT_MS = 10000;

/**
 * Whether this job has anywhere to send error reports. When false, none of
 * the observability machinery (job tracing, error classification, report
 * building) should run at all, since it can never be posted anywhere.
 */
export function hasErrorReporting(dataRequest: DataRequest): boolean {
    return Boolean((dataRequest.error_callback_endpoint || '').trim());
}

function nodePlatform(): string {
    const raw = os.platform();
    return raw === 'darwin' ? 'electron-macos' : raw === 'win32' ? 'electron-windows' : 'electron-linux';
}

function resolveRaw(error: unknown, extra?: unknown): unknown | undefined {
    const fromError = error instanceof ObservedError ? error.raw : undefined;
    if (fromError !== undefined && extra !== undefined) {
        return serializeRaw({ from_error: fromError, extra });
    }
    if (fromError !== undefined) {
        return serializeRaw(fromError);
    }
    if (extra !== undefined) {
        return serializeRaw(extra);
    }
    return undefined;
}

export function buildJobErrorReport(options: {
    dataRequest: DataRequest;
    error: unknown;
    severity: JobErrorSeverity;
    stage?: string;
    batch_execution?: boolean;
    batch_id?: string;
    raw?: unknown;
}): JobErrorReport {
    const { dataRequest, error, severity } = options;
    const trace = currentJobTrace();
    const fallbackStage = options.stage || trace?.stage || 'unknown';
    const classified = classifyError(error, fallbackStage);
    const failedAt = Date.now();
    const startedAt = trace?.startedAt ?? failedAt;
    const raw = resolveRaw(error, options.raw);
    const stack = errorStack(error);

    const report: JobErrorReport = {
        schema_version: 1,
        kind: 'job_error',
        severity,
        recordID: dataRequest.recordID,
        orgId: dataRequest.orgId,
        node_identifier: getIdentifier() || '',
        connectionID: dataRequest.connectionID || '',
        batch_id: options.batch_id || '',
        batch_execution: Boolean(options.batch_execution),
        version: VERSION,
        platform: nodePlatform(),
        request_type: classifyRequestType(dataRequest),
        url: dataRequest.url,
        error_code: classified.code,
        error_stage: classified.stage,
        error_message: errorMessage(error),
        error_name: errorName(error),
        events: trace?.events.slice() ?? [],
        events_dropped: trace?.eventsDropped ?? 0,
        started_at: new Date(startedAt).toISOString(),
        failed_at: new Date(failedAt).toISOString(),
        duration_ms: failedAt - startedAt,
        job: {
            method: dataRequest.method,
            parser_job: Boolean(dataRequest.parser_job),
            saveFile: Boolean(dataRequest.saveFile),
            saveHtml: Boolean(dataRequest.saveHtml),
            saveMarkdown: Boolean(dataRequest.saveMarkdown),
            jar: dataRequest.jar,
            resetJar: dataRequest.resetJar,
            useCereal: jobUsesCereal(dataRequest),
            action_count: dataRequest.actions?.length ?? 0,
            maxWindows: dataRequest.maxWindows,
        },
    };

    if (stack) {
        report.error_stack = stack;
    }
    if (raw !== undefined) {
        report.raw = raw;
    }
    if (dataRequest.method_endpoint) {
        report.job.method_endpoint = dataRequest.method_endpoint;
    }
    if (dataRequest.method_headers && dataRequest.method_headers !== 'no_headers') {
        report.job.method_headers = serializeRaw(dataRequest.method_headers);
    }

    return report;
}

export async function reportJobError(options: {
    dataRequest: DataRequest;
    error: unknown;
    severity: JobErrorSeverity;
    stage?: string;
    batch_execution?: boolean;
    batch_id?: string;
    raw?: unknown;
}): Promise<void> {
    if (!hasErrorReporting(options.dataRequest)) {
        return;
    }
    const endpoint = options.dataRequest.error_callback_endpoint.trim();

    const payload = buildJobErrorReport(options);
    currentJobTrace()?.add('error', `[observability] Reporting ${payload.severity} ${payload.error_code}`, {
        endpoint,
        error_stage: payload.error_stage,
    });

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Mellowtel-Kind': payload.kind,
        'X-Mellowtel-Schema': String(payload.schema_version),
        'X-Mellowtel-Severity': payload.severity,
        'X-Mellowtel-Error-Code': payload.error_code,
        'X-Mellowtel-Error-Stage': payload.error_stage,
        'X-Mellowtel-Request-Type': payload.request_type,
        'X-Mellowtel-Record-Id': payload.recordID,
        'X-Mellowtel-Org-Id': payload.orgId,
        'X-Mellowtel-Node-Id': payload.node_identifier,
        'X-Mellowtel-Version': payload.version,
        'X-Mellowtel-Platform': payload.platform,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        if (!response.ok) {
            const body = await response.text().catch(() => '');
            Logger.error(`[observability] Error callback HTTP ${response.status}: ${body}`);
            return;
        }
        Logger.log(`[observability] Error callback posted ${payload.error_code} for ${payload.recordID}`);
    } catch (error) {
        Logger.error(`[observability] Error callback request failed: ${errorMessage(error)}`);
    } finally {
        clearTimeout(timeout);
    }
}
