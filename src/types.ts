// src/types.ts
export interface MellowtelConfig {
    publishableKey: string;
    options?: {
      disableLogs?: boolean;
      MAX_DAILY_RATE?: number;
    };
  }
  
  export interface MellowtelState {
    isOptedIn: boolean;
    isStarted: boolean;
    nodeId: string;
    publishableKey: string;
    metadataId?: string;
  }
  
  export interface WebSocketMessage {
    type_event?: 'heartbeat' | 'batch';
    method?: 'GET' | 'POST';
    batch_id?: string;
    parallel_executions_batch?: number;
    delay_between_executions?: number;
    recordID?: string;
    [key: string]: any;
  }
  
  export interface BatchConfig {
    batchId: string;
    parallelExecutions: number;
    delayBetweenExecutions: number;
  }
  
  export type ConnectionStatus = 'connected' | 'disconnected' | 'error';