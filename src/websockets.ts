import WebSocket from 'isomorphic-ws';
import { MeasureConnectionSpeed } from './utils/measure-connection-speed';
import { RateLimiter } from './local-rate-limiting/rate-limiter';
import { Logger } from './logger/logger';
import { VERSION } from './constants';
import { processUrl } from './utils/data-helpers';
import { getS3SignedUrls, putHTMLToSigned, putHTMLVisualizerToSigned, putMarkdownToSigned, updateDynamo } from './utils/put-to-signed';
import { DataRequest } from './utils/data-request';
import os from 'os';

export class WebSocketManager {
    private static instance: WebSocketManager;
    private ws: WebSocket | null = null;
    private readonly wsUrl: string = "wss://7joy2r59rf.execute-api.us-east-1.amazonaws.com/production/";
    private identifier: string;
    private reconnectAttempts: number = 0;
    private readonly maxReconnectAttempts: number = 5;
    private readonly reconnectDelay: number = 5000;
    private isConnecting: boolean = false;
    private pingInterval: NodeJS.Timeout | null = null;
    private pongTimeout: NodeJS.Timeout | null = null;
    private readonly pingIntervalTime: number = 60000; // 60 seconds
    private readonly pongTimeoutTime: number = 5000; // receive pong back in < 5 seconds

    private constructor() {
        this.identifier = '';
    }

    public static getInstance(): WebSocketManager {
        if (!WebSocketManager.instance) {
            WebSocketManager.instance = new WebSocketManager();
        }
        return WebSocketManager.instance;
    }

    public async initialize(identifier: string): Promise<boolean> {
        this.identifier = identifier;

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

    private async establishConnection(): Promise<boolean> {
        try {
            this.isConnecting = true;

            const speedMbps = await MeasureConnectionSpeed();
            Logger.log(`[WebSocketManager]: Connection speed: ${speedMbps} Mbps`);

            const rawPlatform = os.platform();

            let platform = rawPlatform == 'darwin' ? 'macos' : rawPlatform == 'win32' ? 'windows' : 'linux'

            this.ws = new WebSocket(
                `${this.wsUrl}?device_id=${this.identifier}&version=${VERSION}&platform=electron-${platform}` + (speedMbps != -1 ? `&speed_download=${speedMbps}` : ``)
            );

            this.setupWebSocketListeners();
            return true;
        } catch (error) {
            Logger.error(`[WebSocketManager]: Connection error - ${error}`);
            return false;
        } finally {
            this.isConnecting = false;
        }
    }

    private setupWebSocketListeners(): void {
        if (!this.ws) return;

        this.ws.onopen = () => {
            Logger.log("[WebSocketManager]: Connection established");
            this.reconnectAttempts = 0;
            this.startPing();
        };

        this.ws.onclose = () => {
            Logger.log("[WebSocketManager]: Connection closed");
            this.resetSocket();
        };

        this.ws.onerror = (error: any) => {
            Logger.error(`[WebSocketManager]: WebSocket error - ${error}`);
        };

        this.ws.onmessage = async (data: any) => {
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

    private startPongTimeout(): void {
        this.clearPongTimeout();
        this.pongTimeout = setTimeout(() => {
            Logger.log("[WebSocketManager]: Pong timeout, closing the current socket..");
            this.ws.close();
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
            if (!json.url) return;

            const dataRequest = DataRequest.fromJson(json);
            Logger.log(`[WebSocketManager]: Received URL to process - ${dataRequest.url}`);

            if (!RateLimiter.shouldContinue()) {
                await this.handleRateLimitReached();
                return;
            }

            await this.processDataRequest(dataRequest);
        } catch (error) {
            Logger.error(`[WebSocketManager]: Error handling message - ${error}`);
        }
    }

    private async processDataRequest(dataRequest: DataRequest): Promise<void> {
        const [processedContent, s3SignedUrls] = await Promise.all([
            processUrl(dataRequest),
            getS3SignedUrls(dataRequest.recordID)
        ]);

        const { uploadURL_html, uploadURL_markDown, uploadURL_htmlVisualizer } = s3SignedUrls;

        const putHtmlPromise = putHTMLToSigned(uploadURL_html, processedContent.html);
        const putMarkdownPromise = putMarkdownToSigned(uploadURL_markDown, processedContent.markdown);

        const promises = [putHtmlPromise, putMarkdownPromise];

        if (processedContent.screenshot) {
            const putHtmlVisualizerPromise = putHTMLVisualizerToSigned(uploadURL_htmlVisualizer, processedContent.screenshot);
            promises.push(putHtmlVisualizerPromise);
        }

        await Promise.all(promises);

        await updateDynamo(
            dataRequest.recordID,
            dataRequest.url,
            dataRequest.htmlTransformer,
            dataRequest.orgId,
            `text_${dataRequest.recordID}.txt`,
            `markDown_${dataRequest.recordID}.txt`,
            `image_${dataRequest.recordID}.png`
        );
    }

    private async handleRateLimitReached(): Promise<void> {
        Logger.log("[WebSocketManager]: Rate limit reached, closing connection...");
        this.disconnect();
    }

    private async reconnect(): Promise<void> {
        if (this.reconnectAttempts === -1) {
            /// The websocket has been voluntarily disconnected.
            return;
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            Logger.log(`[WebSocketManager]: Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => {
                this.initialize(this.identifier);
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
        if (this.ws) {
            this.reconnectAttempts = -1;
            this.ws.close();
            this.ws = null;
            this.stopPing();
        }
    }
}
