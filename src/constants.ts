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
  GET_CONNECTION_STATUS: 'mellowtel:get-connection-status',
  GET_SYSTEM_INFO: 'mellowtel:get-system-info',
  GET_RATE_LIMIT: 'mellowtel:get-rate-limit',
  WS_CONNECT: 'mellowtel:ws-connect',
  WS_DISCONNECT: 'mellowtel:ws-disconnect',
  WS_SEND: 'mellowtel:ws-send',
  SEND_ANALYTICS: 'mellowtel:send-analytics',
  ERROR: 'mellowtel:error',
  CLOSE_WINDOW: 'mellowtel:close-window',
  CONNECTION_STATUS: 'mellowtel:connection-status',
  OPT_IN_STATUS: 'mellowtel:opt-in-status',
  RATE_LIMIT: 'mellowtel:rate-limit'
} as const;
