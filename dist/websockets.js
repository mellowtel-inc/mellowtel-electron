"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketManager = void 0;
const isomorphic_ws_1 = __importDefault(require("isomorphic-ws"));
const measure_connection_speed_1 = require("./utils/measure-connection-speed");
const rate_limiter_1 = require("./local-rate-limiting/rate-limiter");
const logger_1 = require("./logger/logger");
const constants_1 = require("./utils/constants");
const scraping_helpers_1 = require("./utils/scraping-helpers");
const put_to_signed_1 = require("./utils/put-to-signed");
const scrape_request_1 = require("./utils/scrape-request");
const os_1 = __importDefault(require("os"));
class WebSocketManager {
    constructor() {
        this.ws = null;
        this.wsUrl = "wss://7joy2r59rf.execute-api.us-east-1.amazonaws.com/production/";
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 5000;
        this.isConnecting = false;
        this.identifier = '';
    }
    static getInstance() {
        if (!WebSocketManager.instance) {
            WebSocketManager.instance = new WebSocketManager();
        }
        return WebSocketManager.instance;
    }
    async initialize(identifier) {
        this.identifier = identifier;
        if (this.ws !== null) {
            logger_1.Logger.log("[WebSocketManager]: WebSocket is already connected");
            return true;
        }
        if (this.isConnecting) {
            logger_1.Logger.log("[WebSocketManager]: WebSocket connection is in progress");
            return false;
        }
        if (!rate_limiter_1.RateLimiter.shouldContinue(false)) {
            return false;
        }
        return await this.establishConnection();
    }
    async establishConnection() {
        try {
            this.isConnecting = true;
            const speedMbps = await (0, measure_connection_speed_1.MeasureConnectionSpeed)();
            logger_1.Logger.log(`[WebSocketManager]: Connection speed: ${speedMbps} Mbps`);
            const rawPlatform = os_1.default.platform();
            let platform = rawPlatform == 'darwin' ? 'macos' : rawPlatform == 'win32' ? 'windows' : 'linux';
            this.ws = new isomorphic_ws_1.default(`${this.wsUrl}?device_id=${this.identifier}&version=${constants_1.VERSION}&platform=electron-${platform}` + (speedMbps != -1 ? `&speed_download=${speedMbps}` : ``));
            this.setupWebSocketListeners();
            return true;
        }
        catch (error) {
            logger_1.Logger.error(`[WebSocketManager]: Connection error - ${error}`);
            return false;
        }
        finally {
            this.isConnecting = false;
        }
    }
    setupWebSocketListeners() {
        if (!this.ws)
            return;
        this.ws.onopen = () => {
            logger_1.Logger.log("[WebSocketManager]: Connection established");
            this.reconnectAttempts = 0;
        };
        this.ws.onclose = () => {
            logger_1.Logger.log("[WebSocketManager]: Connection closed");
            this.handleReconnection();
        };
        this.ws.onerror = (error) => {
            logger_1.Logger.error(`[WebSocketManager]: WebSocket error - ${error}`);
        };
        this.ws.onmessage = async (data) => {
            await this.handleIncomingMessage(data);
        };
    }
    async handleIncomingMessage(data) {
        try {
            const json = JSON.parse(data.data);
            if (!json.url)
                return;
            const scrapeRequest = scrape_request_1.ScrapeRequest.fromJson(json);
            logger_1.Logger.log(`[WebSocketManager]: Received URL to scrape - ${scrapeRequest.url}`);
            if (!rate_limiter_1.RateLimiter.shouldContinue()) {
                await this.handleRateLimitReached();
                return;
            }
            await this.processScrapeRequest(scrapeRequest);
        }
        catch (error) {
            logger_1.Logger.error(`[WebSocketManager]: Error handling message - ${error}`);
        }
    }
    async processScrapeRequest(scrapeRequest) {
        const scrapedContent = await (0, scraping_helpers_1.scrapeUrl)(scrapeRequest);
        const { uploadURL_html, uploadURL_markDown, uploadURL_htmlVisualizer } = await (0, scraping_helpers_1.getS3SignedUrls)(scrapeRequest.recordID);
        await (0, put_to_signed_1.putHTMLToSigned)(uploadURL_html, scrapedContent.html);
        await (0, put_to_signed_1.putMarkdownToSigned)(uploadURL_markDown, scrapedContent.markdown);
        if (scrapedContent.screenshot) {
            await (0, put_to_signed_1.putHTMLVisualizerToSigned)(uploadURL_htmlVisualizer, scrapedContent.screenshot);
        }
        await (0, put_to_signed_1.updateDynamo)(scrapeRequest.recordID, scrapeRequest.url, scrapeRequest.htmlTransformer, scrapeRequest.orgId, `text_${scrapeRequest.recordID}.txt`, `markDown_${scrapeRequest.recordID}.txt`, `image_${scrapeRequest.recordID}.png`);
    }
    async handleRateLimitReached() {
        logger_1.Logger.log("[WebSocketManager]: Rate limit reached, closing connection...");
        this.disconnect();
    }
    async handleReconnection() {
        /* force close */
        if (this.reconnectAttempts !== -1) {
            this.reconnectAttempts = 0;
            return;
        }
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            logger_1.Logger.log(`[WebSocketManager]: Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => this.initialize(this.identifier), this.reconnectDelay);
        }
    }
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
            this.reconnectAttempts = -1;
        }
    }
}
exports.WebSocketManager = WebSocketManager;
