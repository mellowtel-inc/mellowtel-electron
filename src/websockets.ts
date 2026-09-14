import WebSocket from 'isomorphic-ws';
import { RateLimiter } from './local-rate-limiting/rate-limiter';
import { Logger } from './logger/logger';
import { MAX_DAILY_RATE, VERSION } from './constants';
import { makeFetchRequest, processUrl, processHtmlContent } from './utils/data-helpers';
import { getCerealManager } from './utils/cereal-manager';
import { getWindowPool } from './utils/window-pool';
import { handleJarEvent, resumeJarWindow, shutdownJarWindow } from './utils/jar';
import { getS3SignedUrls, uploadToS3, saveCrawl } from './utils/put-to-signed';
import { DataRequest } from './utils/data-request';
import { incrementRequestCount } from './storage/request-counter';
import { checkWebsocketApproval, getApprovalRecheckDelayMs, getElectronPluginId } from './utils/websocket-approval';
import {
    ObservedError,
    classifyRequestType,
    createJobTrace,
    currentJobTrace,
    hasErrorReporting,
    jobUsesCereal,
    reportJobError,
    runWithJobTrace,
} from './observability';
import os from 'os';

export class WebSocketManager {
    private static instance: WebSocketManager;
    private ws: WebSocket | null = null;
    private readonly wsUrl: string = "wss://ws.mellow.tel";
    private identifier: string;
    private reconnectAttempts: number = 0;
    private readonly maxReconnectAttempts: number = 5;
    private readonly reconnectDelay: number = 5000;
    private isConnecting: boolean = false;
    private isVoluntarilyDisconnected: boolean = false;
    private pingInterval: NodeJS.Timeout | null = null;
    private pongTimeout: NodeJS.Timeout | null = null;
    private healthCheckInterval: NodeJS.Timeout | null = null;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private approvalAbort: AbortController | null = null;
    private deniedApprovalRetryTimeout: NodeJS.Timeout | null = null;
    private readonly pingIntervalTime: number = 60000; // 60 seconds
    private readonly pongTimeoutTime: number = 5000; // receive pong back in < 5 seconds
    private readonly healthCheckIntervalTime: number = 15 * 60 * 1000; // 15 minutes

    private constructor() {
        this.identifier = '';
        const totalMemoryGB = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2);
        Logger.log(`[WebSocketManager]: System RAM: ${totalMemoryGB}GB`);
    }

    public static getInstance(): WebSocketManager {
        if (!WebSocketManager.instance) {
            WebSocketManager.instance = new WebSocketManager();
        }
        return WebSocketManager.instance;
    }

    public async initialize(identifier: string): Promise<boolean> {
        this.identifier = identifier;
        this.isVoluntarilyDisconnected = false;
        getWindowPool().resume();
        getCerealManager().resume();
        resumeJarWindow();

        if (this.ws !== null) {
            Logger.log("[WebSocketManager]: WebSocket is already connected");
            return true;
        }

        if (this.isConnecting) {
            Logger.log("[WebSocketManager]: WebSocket connection is in progress");
            return false;
        }

        if (!RateLimiter.shouldContinue(false)) {
            return false;
        }

        return await this.establishConnection();
    }

    private abortApprovalRequest(): void {
        if (this.approvalAbort) {
            this.approvalAbort.abort();
            this.approvalAbort = null;
        }
    }

    private clearDeniedApprovalRetry(): void {
        if (this.deniedApprovalRetryTimeout) {
            clearTimeout(this.deniedApprovalRetryTimeout);
            this.deniedApprovalRetryTimeout = null;
        }
    }

    private scheduleDeniedApprovalRetry(): void {
        this.clearDeniedApprovalRetry();
        const remainingMs = getApprovalRecheckDelayMs();
        const delayMs = remainingMs > 0 ? remainingMs : 1000;
        Logger.log(`[WebSocketManager]: Scheduling approval re-check in ${delayMs / 60000} minutes`);
        this.deniedApprovalRetryTimeout = setTimeout(() => {
            this.deniedApprovalRetryTimeout = null;
            if (!this.isVoluntarilyDisconnected && this.ws === null) {
                this.initialize(this.identifier);
            }
        }, delayMs);
    }

    private async establishConnection(): Promise<boolean> {
        this.abortApprovalRequest();
        this.approvalAbort = new AbortController();
        const approvalSignal = this.approvalAbort.signal;

        try {
            this.isConnecting = true;

            const speedMbps = 500 as number;
            //  await MeasureConnectionSpeed();
            // Logger.log(`[WebSocketManager]: Connection speed: ${speedMbps} Mbps`);

            const rawPlatform = os.platform();
            const platform = rawPlatform == 'darwin' ? 'macos' : rawPlatform == 'win32' ? 'windows' : 'linux';
            const pluginId = getElectronPluginId();
            const wsPlatform = `electron-${platform}`;

            const isApproved = await checkWebsocketApproval({
                device_id: this.identifier,
                plugin_id: pluginId,
                version: VERSION,
                speed_download: speedMbps,
                platform: wsPlatform,
                manifest_version: 'electron',
            }, approvalSignal);

            if (!isApproved) {
                Logger.log("[WebSocketManager]: Websocket connection not approved by API");
                if (!this.isVoluntarilyDisconnected && !approvalSignal.aborted) {
                    this.scheduleDeniedApprovalRetry();
                }
                return false;
            }

            if (this.isVoluntarilyDisconnected || approvalSignal.aborted) {
                Logger.log("[WebSocketManager]: Connection aborted after approval");
                return false;
            }

            this.clearDeniedApprovalRetry();
            Logger.log("[WebSocketManager]: Websocket connection approved, establishing connection...");

            const queryParams = new URLSearchParams({
                device_id: this.identifier,
                version: VERSION,
                plugin_id: pluginId,
                platform: wsPlatform,
                manifest_version: 'electron',
                ws_client: 'new_ws',
            });
            if (speedMbps != -1) {
                queryParams.set('speed_download', speedMbps.toString());
            }

            this.ws = new WebSocket(`${this.wsUrl}?${queryParams.toString()}`);

            this.setupWebSocketListeners();
            return true;
        } catch (error) {
            Logger.error(`[WebSocketManager]: Connection error - ${error}`);
            return false;
        } finally {
            this.isConnecting = false;
            if (this.approvalAbort?.signal === approvalSignal) {
                this.approvalAbort = null;
            }
        }
    }

    private setupWebSocketListeners(): void {
        if (!this.ws) return;

        this.ws.onopen = () => {
            Logger.log("[WebSocketManager]: Connection established!!!");
            this.reconnectAttempts = 0;
            this.isVoluntarilyDisconnected = false;
            this.startPing();
            this.startHealthCheck();
        };

        this.ws.onclose = () => {
            Logger.log("[WebSocketManager]: Connection closed");
            this.resetSocket();
        };

        this.ws.onerror = (error: any) => {
            Logger.error(`[WebSocketManager]: WebSocket error - ${error}`);
        };

        this.ws.onmessage = async (data: any) => {
            Logger.log(`[WebSocketManager]: Message received from server`);
            await this.handleIncomingMessage(data);
        };

        this.ws.on('pong', () => {
            Logger.log("[WebSocketManager]: Received pong");
            this.clearPongTimeout();
        });
    }

    private startPing(): void {
        this.stopPing();
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
                this.startPongTimeout();
            }
        }, this.pingIntervalTime);
    }

    private stopPing(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        this.clearPongTimeout();
    }

    private startHealthCheck(): void {
        this.stopHealthCheck();
        Logger.log("[WebSocketManager]: Starting health check interval (every 15 minutes)");
        this.healthCheckInterval = setInterval(() => {
            this.performHealthCheck();
        }, this.healthCheckIntervalTime);
    }

    private stopHealthCheck(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
    }

    private performHealthCheck(): void {
        Logger.log("[WebSocketManager]: Performing health check...");
        
        // Don't reconnect if voluntarily disconnected (user opted out)
        if (this.isVoluntarilyDisconnected) {
            Logger.log("[WebSocketManager]: Health check skipped - voluntarily disconnected");
            return;
        }

        if (this.isConnecting) {
            Logger.log("[WebSocketManager]: Health check skipped - connection already in progress");
            return;
        }

        // Check if WebSocket is connected and open
        const isConnected = this.ws !== null && this.ws.readyState === WebSocket.OPEN;
        
        if (!isConnected) {
            Logger.log("[WebSocketManager]: Health check detected disconnected state, attempting to reconnect...");
            // Reset reconnect attempts to allow fresh reconnection
            this.reconnectAttempts = 0;
            this.initialize(this.identifier);
        } else {
            Logger.log("[WebSocketManager]: Health check passed - WebSocket is connected");
        }
    }

    private startPongTimeout(): void {
        this.clearPongTimeout();
        this.pongTimeout = setTimeout(() => {
            Logger.log("[WebSocketManager]: Pong timeout, closing the current socket..");
            if (this.ws) {
                this.ws.close();
            }
        }, this.pongTimeoutTime);
    }

    private clearPongTimeout(): void {
        if (this.pongTimeout) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = null;
        }
    }

    private async handleIncomingMessage(data: any): Promise<void> {
        try {
            const json = JSON.parse(data.data);

            if (json.type_event === 'jar') {
                await handleJarEvent(json);
                return;
            }

            if (json.type_event === 'batch') {
                const batchArray = JSON.parse(json.batch_array);
                await this.handleBatchRequest(batchArray, json.batch_id, json.parallel_executions_batch, json.delay_between_executions);
            } else {
                if (!json.url) return;

                const dataRequest = DataRequest.fromJson(json);
                Logger.log(`[WebSocketManager]: Received URL to process - ${dataRequest.url}`);

                if (!RateLimiter.shouldContinue()) {
                    // Only pay for job tracing / error reporting when this job
                    // actually has somewhere to send it - otherwise there's
                    // nothing to track.
                    if (hasErrorReporting(dataRequest)) {
                        const trace = createJobTrace();
                        await runWithJobTrace(trace, async () => {
                            trace.mark('rate_limit', 'Daily rate limit reached');
                            await reportJobError({
                                dataRequest,
                                error: new ObservedError('RATE LIMIT REACHED', {
                                    code: 'RATE_LIMIT',
                                    stage: 'rate_limit',
                                    raw: { max_daily_rate: MAX_DAILY_RATE },
                                }),
                                severity: 'fatal',
                                stage: 'rate_limit',
                            });
                        });
                    }
                    await this.handleRateLimitReached();
                    return;
                }

                // Process request directly - window pool handles concurrency control
                // Requests that timeout (50s) will be automatically dropped
                this.processDataRequest(dataRequest).catch(error => {
                    Logger.error(`[WebSocketManager]: Error processing request for ${dataRequest.url} - ${error.message}`);
                    // Request is dropped on error (including timeout errors from window pool)
                });
            }
        } catch (error) {
            Logger.error(`[WebSocketManager]: Error handling message - ${error}`);
        }
    }

    private async handleBatchRequest(requests: any[], batch_id: string, parallelExecutions: number, delay: number): Promise<void> {
        for (let i = 0; i < requests.length; i += parallelExecutions) {
            const chunk = requests.slice(i, i + parallelExecutions);
            const promises = chunk.map(requestData => {
                const dataRequest = DataRequest.fromJson(requestData);
                // Catch errors (including timeouts) to prevent one failure from stopping the batch
                return this.processDataRequest(dataRequest, true, batch_id).catch(error => {
                    Logger.error(`[WebSocketManager]: Batch request failed for ${dataRequest.url} - ${error.message}`);
                    // Request is dropped on error (including timeout errors from window pool)
                });
            });

            await Promise.allSettled(promises);

            if (i + parallelExecutions < requests.length) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    private async processDataRequest(dataRequest: DataRequest, batch_execution = false, batch_id = ''): Promise<void> {
        // No error_callback_endpoint on this job means there's nowhere to
        // post a report, so skip creating a job trace and all the Logger
        // hook / event-collection overhead that comes with it - none of it
        // would ever be sent anywhere. Just run the job like before this
        // observability layer existed.
        if (!hasErrorReporting(dataRequest)) {
            return this.runDataRequest(dataRequest, batch_execution, batch_id);
        }

        const trace = createJobTrace();
        await runWithJobTrace(trace, async () => {
            try {
                await this.runDataRequest(dataRequest, batch_execution, batch_id);
            } catch (error) {
                await reportJobError({
                    dataRequest,
                    error,
                    severity: 'fatal',
                    stage: currentJobTrace()?.stage,
                    batch_execution,
                    batch_id,
                });
                throw error;
            }
        });
    }

    private async runDataRequest(dataRequest: DataRequest, batch_execution = false, batch_id = ''): Promise<void> {
        const trace = currentJobTrace();
        trace?.mark('accepted', 'Job accepted', {
            request_type: classifyRequestType(dataRequest),
            recordID: dataRequest.recordID,
            batch_execution,
            batch_id,
        });

        let processedContent: { html: string; markdown: string; screenshot?: Buffer; contentType?: string } | undefined;
        let fileNameBytes: string = "";
        if (dataRequest.parser_job) {
            trace?.mark('parser_fetch', `Parser fetch ${dataRequest.url}`);
            try {
                const response = await fetch(dataRequest.url);
                const content = await response.text();
                if (!response.ok) {
                    throw new ObservedError(`[parser_fetch] HTTP ${response.status} for ${dataRequest.url}`, {
                        code: 'PARSER_FETCH_FAILED',
                        stage: 'parser_fetch',
                        raw: { status: response.status, statusText: response.statusText, body: content },
                    });
                }
                processedContent = { html: content, markdown: '' };
            } catch (error) {
                if (error instanceof ObservedError) {
                    throw error;
                }
                throw new ObservedError(`[parser_fetch] Error fetching ${dataRequest.url} - ${error}`, {
                    code: 'PARSER_FETCH_FAILED',
                    stage: 'parser_fetch',
                    raw: { url: dataRequest.url, error: String(error) },
                    cause: error,
                });
            }
        } else if (dataRequest.method_endpoint) {
            trace?.mark('fetch', `Fetch ${dataRequest.method} ${dataRequest.method_endpoint}`);
            const fetchResult = await makeFetchRequest(dataRequest);
            if (dataRequest.saveFile) {
                trace?.mark('s3', `Upload file for ${dataRequest.recordID}`);
                const { uploadUrl, fileName } = await getS3SignedUrls(dataRequest.recordID, fetchResult.contentType ?? 'application/octet-stream');
                await uploadToS3(uploadUrl, fetchResult.contentType ?? 'application/octet-stream', fetchResult.content);
                fileNameBytes = fileName;
                processedContent = { html: '', markdown: '' };
            } else {
                trace?.mark('process_html', 'Process fetched HTML in window pool');
                const contentString = fetchResult.content.toString('utf-8');
                processedContent = await processHtmlContent(contentString, dataRequest);
            }
        } else {
            trace?.mark('scrape', `Scrape ${dataRequest.url}`);
            processedContent = await processUrl(dataRequest);
        }

        if (hasErrorReporting(dataRequest)) {
            const failedActions = (dataRequest.actionResults || []).filter(
                (result) => result.status === 'failed' || result.status === 'timeout'
            );
            if (failedActions.length > 0) {
                await reportJobError({
                    dataRequest,
                    error: new ObservedError(`${failedActions.length} action step(s) failed`, {
                        code: 'ACTION_FAILED',
                        stage: 'actions',
                        raw: { actionResults: dataRequest.actionResults },
                    }),
                    severity: 'partial',
                    stage: 'actions',
                    batch_execution,
                    batch_id,
                });
            }
        }

        let cereal_result: any = {};
        let cereal_success = true;
        try {
            if (jobUsesCereal(dataRequest)) {
                trace?.mark('cereal', 'Running cereal extraction');
                Logger.log("[processDataRequest] : using cereal [🥣] with optimized CerealManager");

                const cerealManager = getCerealManager();
                cereal_result = await cerealManager.processCerealJob(
                    dataRequest.cerealObject,
                    dataRequest.recordID,
                    processedContent.html
                );

                Logger.log("[processDataRequest] : cereal_result => ");
                Logger.log(cereal_result);
                Logger.log("############################################");
            }
        } catch (e) {
            cereal_success = false;
            Logger.log(
                "[processDataRequest] : error in cereal processing => ",
                e,
            );
            if (hasErrorReporting(dataRequest)) {
                await reportJobError({
                    dataRequest,
                    error: e,
                    severity: 'partial',
                    stage: 'cereal',
                    batch_execution,
                    batch_id,
                });
            }
            cereal_result = {};
        }

        trace?.mark('save_crawl', 'Posting crawl result');
        await saveCrawl(
            dataRequest,
            processedContent.html,
            processedContent.markdown,
            batch_execution,
            batch_id,
            false,
            cereal_result,
            fileNameBytes,
            cereal_success
        );

        incrementRequestCount();
        trace?.mark('completed', 'Job completed');
    }

    private async handleRateLimitReached(): Promise<void> {
        Logger.log("[WebSocketManager]: Rate limit reached, closing connection...");
        await this.shutdown();
    }

    private async reconnect(): Promise<void> {
        if (this.reconnectAttempts === -1) {
            /// The websocket has been voluntarily disconnected.
            return;
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            Logger.log(`[WebSocketManager]: Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            this.reconnectTimeout = setTimeout(() => {
                this.reconnectTimeout = null;
                if (!this.isVoluntarilyDisconnected) {
                    this.initialize(this.identifier);
                }
            }, this.reconnectDelay);
        }
    }

    private resetSocket(): void {
        if (this.ws) {
            this.ws = null;
            this.stopPing();
            this.reconnect();
        }
    }

    /// Voluntarily disconnect websocket
    public disconnect(): void {
        Logger.log("[WebSocketManager]: Voluntarily disconnecting...");
        this.isVoluntarilyDisconnected = true;
        this.reconnectAttempts = -1;
        this.abortApprovalRequest();
        this.clearDeniedApprovalRetry();
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        this.stopPing();
        this.stopHealthCheck();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    /**
     * Disconnect and release all request-processing resources.
     */
    public async shutdown(): Promise<void> {
        this.disconnect();
        await Promise.all([
            getWindowPool().shutdown(),
            getCerealManager().shutdown(),
            shutdownJarWindow(),
        ]);
    }
}
