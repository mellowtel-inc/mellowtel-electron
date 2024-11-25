export declare class WebSocketManager {
    private static instance;
    private ws;
    private readonly wsUrl;
    private identifier;
    private reconnectAttempts;
    private readonly maxReconnectAttempts;
    private readonly reconnectDelay;
    private isConnecting;
    private constructor();
    static getInstance(): WebSocketManager;
    initialize(identifier: string): Promise<boolean>;
    private establishConnection;
    private setupWebSocketListeners;
    private handleIncomingMessage;
    private processScrapeRequest;
    private handleRateLimitReached;
    private handleReconnection;
    disconnect(): void;
}
