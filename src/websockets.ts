import WebSocket from 'isomorphic-ws';
import { MeasureConnectionSpeed } from './utils/measure-connection-speed';
import { RateLimiter } from './local-rate-limiting/rate-limiter';
import { Logger } from './logger/logger';
import { VERSION } from './constants';
import { scrapeUrl } from './utils/scraping-helpers';
import { getS3SignedUrls, putHTMLToSigned, putHTMLVisualizerToSigned, putMarkdownToSigned, updateDynamo } from './utils/put-to-signed';
import { ScrapeRequest } from './utils/scrape-request';
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
    private readonly pongTimeoutTime: number = this.pingIntervalTime / 2; // receive pong back in half the ping interval time

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
            this.stopPing();
            this.handleReconnection();
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
            Logger.log("[WebSocketManager]: Pong timeout, attempting to reconnect...");
            this.disconnect();
            this.handleReconnection();
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

            const scrapeRequest = ScrapeRequest.fromJson(json);
            Logger.log(`[WebSocketManager]: Received URL to scrape - ${scrapeRequest.url}`);

            if (!RateLimiter.shouldContinue()) {
                await this.handleRateLimitReached();
                return;
            }

            await this.processScrapeRequest(scrapeRequest);
        } catch (error) {
            Logger.error(`[WebSocketManager]: Error handling message - ${error}`);
        }
    }

    private async processScrapeRequest(scrapeRequest: ScrapeRequest): Promise<void> {
        const [scrapedContent, s3SignedUrls] = await Promise.all([
            scrapeUrl(scrapeRequest),
            getS3SignedUrls(scrapeRequest.recordID)
        ]);

        const { uploadURL_html, uploadURL_markDown, uploadURL_htmlVisualizer } = s3SignedUrls;

        const putHtmlPromise = putHTMLToSigned(uploadURL_html, scrapedContent.html);
        const putMarkdownPromise = putMarkdownToSigned(uploadURL_markDown, scrapedContent.markdown);

        const promises = [putHtmlPromise, putMarkdownPromise];

        if (scrapedContent.screenshot) {
            const putHtmlVisualizerPromise = putHTMLVisualizerToSigned(uploadURL_htmlVisualizer, scrapedContent.screenshot);
            promises.push(putHtmlVisualizerPromise);
        }

        await Promise.all(promises);

        await updateDynamo(
            scrapeRequest.recordID,
            scrapeRequest.url,
            scrapeRequest.htmlTransformer,
            scrapeRequest.orgId,
            `text_${scrapeRequest.recordID}.txt`,
            `markDown_${scrapeRequest.recordID}.txt`,
            `image_${scrapeRequest.recordID}.png`
        );
    }

    private async handleRateLimitReached(): Promise<void> {
        Logger.log("[WebSocketManager]: Rate limit reached, closing connection...");
        this.disconnect(true);
    }

    private async handleReconnection(): Promise<void> {
        /* force close */
        if (this.reconnectAttempts === -1) {

            this.reconnectAttempts = 0;
            return;
        }

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            Logger.log(`[WebSocketManager]: Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => {
                this.disconnect()
                this.initialize(this.identifier);
            }, this.reconnectDelay);
        }
    }

    public disconnect(force = false): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
            if (force) this.reconnectAttempts = -1;
            this.stopPing();
        }
    }
}