import WebSocket from 'isomorphic-ws';
import { MeasureConnectionSpeed } from './utils/measure-connection-speed';
import { RateLimiter } from './local-rate-limiting/rate-limiter';
import { Logger } from './logger/logger';
import { setLocalStorage } from './storage/storage-helpers';
import { VERSION, REFRESH_INTERVAL } from './constants';
import { getS3SignedUrls, scrapeUrl } from './utils/scraping-helpers';
import { putHTMLToSigned, putHTMLVisualizerToSigned, putMarkdownToSigned, updateDynamo } from './utils/put-to-signed';
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
        console.log(`this ws: ${this.ws}`);
        this.identifier = identifier;

        if (this.ws !== null) {
            Logger.log("[WebSocketManager]: WebSocket is already connected");
            return true;
        }

        if (this.isConnecting) {
            Logger.log("[WebSocketManager]: WebSocket connection is in progress");
            return false;
        }

        const limitReached = await RateLimiter.getIfRateLimitReached();
        if (limitReached) {
            return await this.handleRateLimit();
        }

        return await this.establishConnection();
    }

    private async establishConnection(): Promise<boolean> {
        try {
            this.isConnecting = true;

            const speedMbps = await MeasureConnectionSpeed();
            Logger.log(`[WebSocketManager]: Connection speed: ${speedMbps} Mbps`);

            const platform = os.platform(); // Get the platform

            this.ws = new WebSocket(
                `${this.wsUrl}?device_id=${this.identifier}&version=${VERSION}&platform=electron-${platform}&speed_download=${speedMbps}`
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
        };

        this.ws.onclose = () => {
            Logger.log("[WebSocketManager]: Connection closed");
            this.handleReconnection();
        };

        this.ws.onerror = (error: any) => {
            Logger.error(`[WebSocketManager]: WebSocket error - ${error}`);
        };

        this.ws.onmessage = async (data: any) => {
            await this.handleIncomingMessage(data);
        };
    }

    private async handleIncomingMessage(data: any): Promise<void> {
        try {
            const json = JSON.parse(data.data);
            if (!json.url) return;

            const scrapeRequest = ScrapeRequest.fromJson(json);
            Logger.log(`[WebSocketManager]: Received URL to scrape - ${scrapeRequest.url}`);

            const { shouldContinue, isLastCount } = await RateLimiter.checkRateLimit(true);
            if (!shouldContinue) {
                await this.handleRateLimitReached();
                return;
            }

            await this.processScrapeRequest(scrapeRequest);
        } catch (error) {
            Logger.error(`[WebSocketManager]: Error handling message - ${error}`);
        }
    }

    private async processScrapeRequest(scrapeRequest: ScrapeRequest): Promise<void> {
        const scrapedContent = await scrapeUrl(scrapeRequest);
        const { uploadURL_html, uploadURL_markDown, uploadURL_htmlVisualizer } = await getS3SignedUrls(scrapeRequest.recordID);

        await putHTMLToSigned(uploadURL_html, scrapedContent.html);
        await putMarkdownToSigned(uploadURL_markDown, scrapedContent.markdown);

        if (scrapedContent.screenshot) {
            await putHTMLVisualizerToSigned(uploadURL_htmlVisualizer, scrapedContent.screenshot);
        }

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

    private async handleRateLimit(): Promise<boolean> {
        const { timestamp, count } = await RateLimiter.getRateLimitData();
        const timeElapsed = RateLimiter.calculateElapsedTime(Date.now(), timestamp);

        if (timeElapsed > REFRESH_INTERVAL) {
            setLocalStorage("mllwtl_rate_limit_reached", false);
            await RateLimiter.resetRateLimitData(Date.now(), false);
            return await this.establishConnection();
        }
        return false;
    }

    private async handleRateLimitReached(): Promise<void> {
        Logger.log("[WebSocketManager]: Rate limit reached, closing connection...");
        await setLocalStorage("mllwtl_rate_limit_reached", true);
        this.disconnect();
    }

    private async handleReconnection(): Promise<void> {
        /* force close */
        if ( this.reconnectAttempts !== -1 ){
           
            this.reconnectAttempts = 0;
            return ;
        }

        if ( this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            Logger.log(`[WebSocketManager]: Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => this.initialize(this.identifier), this.reconnectDelay);
        }
    }

    public disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
            this.reconnectAttempts = -1;
        }
    }
}