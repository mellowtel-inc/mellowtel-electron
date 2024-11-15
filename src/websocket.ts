// src/websocket.ts
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

export class MellowtelWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private identifier: string;
  private extensionId: string;
  private rateLimitData: {
    count: number;
    timestamp: number;
    isLimited: boolean;
  };

  constructor(identifier: string, extensionId: string) {
    super();
    this.identifier = identifier;
    this.extensionId = extensionId;
    this.rateLimitData = {
      count: 0,
      timestamp: Date.now(),
      isLimited: false
    };
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

  public connect() {
    const params = new URLSearchParams({
      node_id: this.identifier,
      version: VERSION,
      extension_id: this.extensionId,
      client: 'electron'
    });

    this.ws = new WebSocket(`${WS_URL}?${params.toString()}`);

    this.ws.on('open', () => {
      this.emit('connected', { identifier: this.identifier });
    });

    this.ws.on('message', async (data: WebSocket.Data) => {
      try {
        const parsedData = JSON.parse(data.toString()) as WebSocketMessage;

        if (parsedData.type_event === 'heartbeat') {
          return;
        }

        const isSpecialRequest = 
          parsedData.method === 'POST' || 
          parsedData.type_event === 'batch' ||
          parsedData.method === 'GET';

        if (!isSpecialRequest) {
          const { shouldContinue, isLastCount } = await this.checkRateLimit();
          
          if (!shouldContinue) {
            this.rateLimitData.isLimited = true;
            this.disconnect();
            return;
          }

          if (isLastCount) {
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
            delayBetweenExecutions: parsedData.delay_between_executions  || 500
          };
          
          this.emit('batch', parsedData, batchConfig);
          return;
        }

        this.emit('message', parsedData);
      } catch (error) {
        this.emit('error', error);
      }
    });

    this.ws.on('close', () => {
      this.emit('disconnected');
    });

    this.ws.on('error', (error) => {
      this.emit('error', error);
    });
  }

  public disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}