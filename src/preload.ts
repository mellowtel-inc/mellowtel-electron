// src/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

// Types for the exposed API
interface MellowtelAPI {
  getState: () => Promise<any>;
  updateSettings: (settings: any) => Promise<void>;
  sendAnalytics: (data: any) => Promise<void>;
  getConnectionStatus: () => Promise<{
    status: 'connected' | 'disconnected' | 'error';
    lastAttempt: number;
  }>;
  getRateLimit: () => Promise<{
    count: number;
    timestamp: number;
    isLimited: boolean;
  }>;
  // System info methods
  getSystemInfo: () => Promise<{
    platform: string;
    version: string;
    arch: string;
  }>;
  // WebSocket related methods
  wsConnect: () => Promise<void>;
  wsDisconnect: () => Promise<void>;
  wsSend: (message: any) => Promise<void>;
  // Event subscription
  on: (channel: string, callback: (...args: any[]) => void) => void;
  off: (channel: string, callback: (...args: any[]) => void) => void;
}

// List of valid channels for events
const validChannels = [
  'mellowtel:connection-status',
  'mellowtel:opt-in-status',
  'mellowtel:rate-limit',
  'mellowtel:error',
  'mellowtel:message'
] as const;

type ValidChannel = typeof validChannels[number];

// Expose protected methods that allow the renderer process to use
contextBridge.exposeInMainWorld(
  'mellowtel',
  {
    // State management
    getState: async () => {
      return await ipcRenderer.invoke('mellowtel:get-state');
    },

    updateSettings: async (settings: any) => {
      return await ipcRenderer.invoke('mellowtel:update-settings', settings);
    },

    // Analytics
    sendAnalytics: async (data: any) => {
      return await ipcRenderer.invoke('mellowtel:send-analytics', data);
    },

    // Connection status
    getConnectionStatus: async () => {
      return await ipcRenderer.invoke('mellowtel:get-connection-status');
    },

    // Rate limiting
    getRateLimit: async () => {
      return await ipcRenderer.invoke('mellowtel:get-rate-limit');
    },

    // System information
    getSystemInfo: async () => {
      return await ipcRenderer.invoke('mellowtel:get-system-info');
    },

    // WebSocket methods
    wsConnect: async () => {
      return await ipcRenderer.invoke('mellowtel:ws-connect');
    },

    wsDisconnect: async () => {
      return await ipcRenderer.invoke('mellowtel:ws-disconnect');
    },

    wsSend: async (message: any) => {
      return await ipcRenderer.invoke('mellowtel:ws-send', message);
    },

    // Event handling
    on: (channel: string, callback: (...args: any[]) => void) => {
      if (validChannels.includes(channel as ValidChannel)) {
        const subscription = (_event: any, ...args: any[]) => callback(...args);
        ipcRenderer.on(channel, subscription);
      }
    },

    off: (channel: string, callback: (...args: any[]) => void) => {
      if (validChannels.includes(channel as ValidChannel)) {
        ipcRenderer.removeListener(channel, callback);
      }
    }
  } as MellowtelAPI
);

// Declare the API types for TypeScript users
declare global {
  interface Window {
    mellowtel: MellowtelAPI;
  }
}

// Handle uncaught errors in the renderer process
window.addEventListener('error', (event) => {
  ipcRenderer.invoke('mellowtel:error', {
    message: event.error.message,
    stack: event.error.stack
  });
});

// Handle unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  ipcRenderer.invoke('mellowtel:error', {
    message: event.reason?.message || 'Unhandled promise rejection',
    stack: event.reason?.stack
  });
});

// Optional: Type-safe event emitter for the main process
export interface MellowtelEvents {
  'connection-status': (status: 'connected' | 'disconnected' | 'error') => void;
  'opt-in-status': (status: boolean) => void;
  'rate-limit': (data: { count: number; isLimited: boolean }) => void;
  'error': (error: Error) => void;
  'message': (data: any) => void;
}

// Example usage in renderer process:
/*
  // Get state
  const state = await window.mellowtel.getState();

  // Update settings
  await window.mellowtel.updateSettings({ isOptedIn: true });

  // Listen for events
  window.mellowtel.on('mellowtel:connection-status', (status) => {
    console.log('Connection status:', status);
  });

  // Send WebSocket message
  await window.mellowtel.wsSend({ type: 'hello' });

  // Get system info
  const systemInfo = await window.mellowtel.getSystemInfo();

  // Get rate limit info
  const rateLimit = await window.mellowtel.getRateLimit();
*/