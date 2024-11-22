import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { 
  VERSION, 
  WS_URL, 
  HIGH_BANDWIDTH_CONNECTION_TYPES,
  MAX_PARALLEL_EXECUTIONS_BATCH,
  MAX_PARALLEL_EXECUTIONS_BATCH_FETCH,
  REFRESH_INTERVAL
} from './constants';
import { WebSocketMessage, BatchConfig } from './types';
import { Logger } from './utils/logger';

export class MellowtelWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private identifier: string;
  private extensionId: string;
  private connectionStartTime: number = 0;
  private rateLimitData: {
    count: number;
    timestamp: number;
    isLimited: boolean;
  };
  private readonly platform: string = process.platform === 'darwin' ? 'electron-macos' : 'electron-windows';
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastHeartbeat: number = 0;
  private readonly HEARTBEAT_TIMEOUT = 45000; // 45s timeout
  private readonly HEARTBEAT_INTERVAL = 15000; // 15s interval

  constructor(identifier: string, extensionId: string) {
    super();
    this.identifier = identifier;
    this.extensionId = extensionId;

    this.setupHeartbeat = this.setupHeartbeat.bind(this);
    this.handleHeartbeat = this.handleHeartbeat.bind(this);
    this.rateLimitData = {
      count: 0,
      timestamp: Date.now(),
      isLimited: false
    };
  }
  

  private readonly HEARTBEAT_LOG_SIZE = 100;
private heartbeatLog: Array<{
   sent: number;
   received?: number;
   latency?: number;
}> = [];

private setupHeartbeat() {
  Logger.log('Setting up heartbeat monitor');
  this.lastHeartbeat = Date.now();
  
  if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
  }

  this.heartbeatInterval = setInterval(() => {
      if (!this.isConnected()) {
          Logger.log('Heartbeat skipped - not connected');
          return;
      }
      
      if (Date.now() - this.lastHeartbeat > this.HEARTBEAT_TIMEOUT) {
          const connectionStatus = this.getConnectionStatus();
          Logger.error('Heartbeat timeout detected', {
              lastHeartbeat: new Date(this.lastHeartbeat).toISOString(),
              missedPings: this.heartbeatLog
                  .filter(ping => !ping.received)
                  .slice(-5),
              wsReadyState: this.getReadyStateString(),
              connectionStatus,
              socketBufferSize: this.ws?.bufferedAmount,
              timeSinceLastActivity: Date.now() - this.lastHeartbeat
          });
          return;
      }
      
      const pingTime = Date.now();
      this.heartbeatLog.push({ sent: pingTime });
      if (this.heartbeatLog.length > this.HEARTBEAT_LOG_SIZE) {
          this.heartbeatLog.shift();
      }
      
      Logger.log('❤️ Heartbeat sent', { 
          timestamp: new Date(pingTime).toISOString(),
          connectionUptime: `${Math.floor((Date.now() - this.connectionStartTime) / 1000)}s`,
          totalPings: this.heartbeatLog.length,
          avgLatency: this.calculateAverageLatency()
      });
      this.ws?.ping();
  }, this.HEARTBEAT_INTERVAL);
}

private calculateAverageLatency(): number {
    const latencies = this.heartbeatLog
        .filter(ping => ping.latency)
        .map(ping => ping.latency!);
    return latencies.length ? 
        Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 
        0;
}

private handleHeartbeat() {
    const now = Date.now();
    this.lastHeartbeat = now;
    
    const lastPing = this.heartbeatLog[this.heartbeatLog.length - 1];
    if (lastPing && !lastPing.received) {
        lastPing.received = now;
        lastPing.latency = now - lastPing.sent;
        Logger.log('💓 Heartbeat received', {
            latency: `${lastPing.latency}ms`,
            sent: new Date(lastPing.sent).toISOString(),
            received: new Date(now).toISOString(),
            missedBeats: this.heartbeatLog.filter(ping => !ping.received).length
        });
    }
}

  
  private logConnectionInfo() {
    if (!this.ws) return;

    const connectionInfo = {
      timestamp: new Date().toISOString(),
      readyState: this.getReadyStateString(),
      url: this.ws.url,
      protocol: this.ws.protocol,
      identifier: this.identifier,
      extensionId: this.extensionId,
      connectionDuration: `${Date.now() - this.connectionStartTime}ms`,
      bufferedAmount: this.ws.bufferedAmount,
      rateLimitStatus: {
        count: this.rateLimitData.count,
        isLimited: this.rateLimitData.isLimited,
        timeUntilReset: Math.max(0, REFRESH_INTERVAL - (Date.now() - this.rateLimitData.timestamp))
      }
    };

    Logger.log('WebSocket Connection Info:', connectionInfo);
    return connectionInfo;
  }
 
  private async checkRateLimit(): Promise<{ shouldContinue: boolean; isLastCount: boolean }> {
    const now = Date.now();
    const timeElapsed = now - this.rateLimitData.timestamp;

    if (timeElapsed > REFRESH_INTERVAL) {
      this.rateLimitData = {
        count: 0,
        timestamp: now,
        isLimited: false
      };
      return { shouldContinue: true, isLastCount: false };
    }

    if (this.rateLimitData.isLimited) {
      return { shouldContinue: false, isLastCount: false };
    }

    this.rateLimitData.count++;
    const isLastCount = this.rateLimitData.count >= 100;
    
    return { shouldContinue: true, isLastCount };
  }

  private getReadyStateString(): string {
    if (!this.ws) return 'NOT_INITIALIZED';
    
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING:
        return 'CONNECTING';
      case WebSocket.OPEN:
        return 'OPEN';
      case WebSocket.CLOSING:
        return 'CLOSING';
      case WebSocket.CLOSED:
        return 'CLOSED';
      default:
        return 'UNKNOWN';
    }
  }

  public connect() {
    const wsUrl = `wss://7joy2r59rf.execute-api.us-east-1.amazonaws.com/production/?node_id=${this.identifier}&version=${VERSION}&platform=${this.platform}`;
   
    Logger.log("Initiating connection to:", wsUrl);
    
    this.connectionStartTime = Date.now();
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      const connectionInfo = this.logConnectionInfo();
      Logger.log("WebSocket connection established successfully");

      this.setupHeartbeat(); 
      this.emit('connected', { 
        identifier: this.identifier,
        url: wsUrl,
        connectionInfo
      });
    });

    this.ws.on('ping', () => {
      Logger.log('Received ping');
      this.logConnectionInfo();
    });

    this.ws.on('pong', () => {
      Logger.log('Received pong');
      this.logConnectionInfo();
    });

    this.ws.on('message', async (data: WebSocket.Data) => {
      try {
        const parsedData = JSON.parse(data.toString()) as WebSocketMessage;
        Logger.log('Received message type:', parsedData.type_event);

        if (parsedData.type_event === 'heartbeat') {
          this.logConnectionInfo();
          return;
        }

        const isSpecialRequest = 
          parsedData.method === 'POST' || 
          parsedData.type_event === 'batch' ||
          parsedData.method === 'GET';

        if (!isSpecialRequest) {
          const { shouldContinue, isLastCount } = await this.checkRateLimit();
          
          if (!shouldContinue) {
            Logger.log('Rate limit reached - disconnecting');
            this.rateLimitData.isLimited = true;
            this.disconnect();
            return;
          }

          if (isLastCount) {
            Logger.log('Final rate limit count reached - disconnecting');
            this.rateLimitData.isLimited = true;
            this.disconnect();
          }
        }

        if (parsedData.type_event === 'batch') {
          const batchConfig: BatchConfig = {
            batchId: parsedData.batch_id!,
            parallelExecutions: Math.min(
              parsedData.parallel_executions_batch || MAX_PARALLEL_EXECUTIONS_BATCH,
              parsedData.type_batch === 'fetch' ? MAX_PARALLEL_EXECUTIONS_BATCH_FETCH : MAX_PARALLEL_EXECUTIONS_BATCH
            ),
            delayBetweenExecutions: parsedData.delay_between_executions || 500
          };
          
          Logger.log('Processing batch:', batchConfig);
          this.emit('batch', parsedData, batchConfig);
          return;
        }

        this.emit('message', parsedData);
      } catch (error) {
        Logger.log('Error processing message:', error);
        this.emit('error', error);
      }
    });

    this.ws.on('close', (code: number, reason: string) => {
      const connectionInfo = this.logConnectionInfo();
      Logger.log("WebSocket connection closed", {
        code,
        reason: reason.toString(),
        connectionDuration: connectionInfo?.connectionDuration
      });
      this.emit('disconnected', { code, reason, connectionInfo });
    });

    this.ws.on('error', (error) => {
      const connectionInfo = this.logConnectionInfo();
      Logger.log("WebSocket error:", {
        error,
        connectionInfo
      });
      this.emit('error', error);
    });
  }

  public disconnect() {
    if (this.ws) {
      const connectionInfo = this.logConnectionInfo();
      Logger.log("Initiating disconnect", { connectionInfo });
      this.ws.close();
      this.ws = null;
    }
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  public getConnectionStatus() {
    return this.logConnectionInfo();
  }
}