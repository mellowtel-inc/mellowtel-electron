export type JobErrorSeverity = 'fatal' | 'partial';

export type JobRequestType = 'parser' | 'fetch' | 'fetch_file' | 'scrape';

export type JobTraceLevel = 'info' | 'warn' | 'error';

export type JobErrorCode =
    | 'RATE_LIMIT'
    | 'NAVIGATION_FAILED'
    | 'FETCH_FAILED'
    | 'PARSER_FETCH_FAILED'
    | 'SCRAPE_FAILED'
    | 'SCRAPE_TIMEOUT'
    | 'HTML_PROCESS_TIMEOUT'
    | 'WINDOW_ACQUIRE_TIMEOUT'
    | 'WINDOW_POOL_FAILED'
    | 'JAR_FAILED'
    | 'CEREAL_FAILED'
    | 'CEREAL_TIMEOUT'
    | 'S3_SIGN_FAILED'
    | 'S3_UPLOAD_FAILED'
    | 'SAVE_CRAWL_FAILED'
    | 'ACTION_FAILED'
    | 'NODE_SHUTDOWN'
    | 'JOB_TIMEOUT'
    | 'JOB_FAILED';

export interface JobTraceEvent {
    seq: number;
    ts: number;
    at: string;
    level: JobTraceLevel;
    stage: string;
    message: string;
    data?: unknown;
}

export interface JobErrorReport {
    schema_version: 1;
    kind: 'job_error';
    severity: JobErrorSeverity;
    recordID: string;
    orgId: string;
    node_identifier: string;
    connectionID: string;
    batch_id: string;
    batch_execution: boolean;
    version: string;
    platform: string;
    request_type: JobRequestType;
    url: string;
    error_code: JobErrorCode;
    error_stage: string;
    error_message: string;
    error_name: string;
    error_stack?: string;
    raw?: unknown;
    events: JobTraceEvent[];
    events_dropped: number;
    started_at: string;
    failed_at: string;
    duration_ms: number;
    job: {
        method: string;
        method_endpoint?: string;
        parser_job: boolean;
        saveFile: boolean;
        saveHtml: boolean;
        saveMarkdown: boolean;
        jar: string;
        resetJar: string;
        useCereal: boolean;
        action_count: number;
        maxWindows?: number;
        method_headers?: unknown;
    };
}
