// src/constants.ts
export const VERSION = '1.0.0';
export const REFRESH_INTERVAL = 3600000; // 1 hour
export const MAX_PARALLEL_EXECUTIONS_BATCH = 4;
export const MAX_PARALLEL_EXECUTIONS_BATCH_FETCH = 2;
export const WS_URL = "wss://7joy2r59rf.execute-api.us-east-1.amazonaws.com/production/";
export const HIGH_BANDWIDTH_CONNECTION_TYPES = ['4g', 'wifi'] as const;
export const DEFAULT_MAX_DAILY_RATE = 1000;

export const IPC_CHANNELS = {
  GET_STATE: 'mellowtel:get-state',
  UPDATE_SETTINGS: 'mellowtel:update-settings',
  WS_MESSAGE: 'mellowtel:ws-message',
} as const;