import { app, BrowserWindow, ipcMain } from 'electron';
import { MellowtelStore } from './store';
import { MellowtelWebSocket } from './websocket';
import { VERSION, DEFAULT_MAX_DAILY_RATE, IPC_CHANNELS } from './constants';
import path from 'path';
import { getOrGenerateIdentifier } from './utils/identity-helper';
import { Logger } from './utils/logger';
import { RateLimiter } from './utils/rate-limit';

export default class Mellowtel {
  private publishableKey: string;
  private options: any;
  private store: MellowtelStore;
  private window: BrowserWindow | null = null;
  private wsClient: MellowtelWebSocket | null = null;
  private nodeId: string = '';

  constructor(publishableKey: string, options?: any) {
    if (!publishableKey) {
      throw new Error("publishableKey is undefined, null, or empty");
    }

    this.publishableKey = publishableKey;
    this.options = options || {};
    Logger.setLogEnabled(!options?.disableLogs);
    RateLimiter.setMaxDailyRate(options?.MAX_DAILY_RATE || DEFAULT_MAX_DAILY_RATE);
    this.store = MellowtelStore.getInstance();
    
    this.setupIpcHandlers();
  }

  
  private setupIpcHandlers() {
    // System/State handlers
    ipcMain.handle(IPC_CHANNELS.GET_STATE, () => this.store.getState());
    ipcMain.handle(IPC_CHANNELS.GET_SYSTEM_INFO, () => ({
      platform: process.platform,
      version: app.getVersion(),
      arch: process.arch
    }));

    // Connection/WebSocket handlers
    ipcMain.handle(IPC_CHANNELS.GET_CONNECTION_STATUS, () => ({
      status: this.wsClient?.isConnected() ? 'connected' : 'disconnected',
      lastAttempt: Date.now()
    }));
    
    ipcMain.handle(IPC_CHANNELS.WS_CONNECT, () => this.wsClient?.connect());
    ipcMain.handle(IPC_CHANNELS.WS_DISCONNECT, () => this.wsClient?.disconnect());
    ipcMain.handle(IPC_CHANNELS.WS_SEND, (_, message: any) => {
      if (this.wsClient?.isConnected()) {
        return this.wsClient.emit(message);
      }
      throw new Error('WebSocket not connected');
    });

    // Settings/Opt-in handlers
    ipcMain.handle(IPC_CHANNELS.UPDATE_SETTINGS, async (_, settings: any) => {
      this.store.setState(settings);
      if (settings.isOptedIn !== undefined) {
        if (settings.isOptedIn) {
          await this.setupWebSocket();
        } else if (this.wsClient) {
          this.wsClient.disconnect();
        }
      }
    });

    // Analytics/Error handlers
    ipcMain.handle(IPC_CHANNELS.SEND_ANALYTICS, (_, data: any) => {
      Logger.log('Analytics:', data);
    });

    ipcMain.handle(IPC_CHANNELS.ERROR, (_, error: Error) => {
      Logger.error('Error:', error);
    });

    // Rate limiting
    ipcMain.handle(IPC_CHANNELS.GET_RATE_LIMIT, () => this.store.getRateLimit());

    // Window management
    ipcMain.on(IPC_CHANNELS.CLOSE_WINDOW, () => {
      if (this.window) {
        this.window.close();
        this.window = null;
      }
    });
  }

  private async setupWebSocket() {
    const nodeId = await this.getNodeId();
    this.wsClient = new MellowtelWebSocket(nodeId, this.publishableKey);

    this.wsClient.on('connected', () => {
      Logger.log('WebSocket connected');
    });

    this.wsClient.on('message', (data) => {
      Logger.log('Received message:', data);
      if (this.window) {
        this.window.webContents.send(IPC_CHANNELS.WS_MESSAGE, data);
      }
    });

    this.wsClient.on('batch', (data, config) => {
      Logger.log('Batch received:', data, config);
    });

    this.wsClient.connect();
  }

  public async initBackground(autoStartIfOptedIn?: boolean, metadataId?: string): Promise<void> {
    await getOrGenerateIdentifier(this.publishableKey);
    if (autoStartIfOptedIn !== false) {
      const optInStatus = await this.getOptInStatus();
      if (optInStatus) {
        await this.start(metadataId);
      }
    }
  }

  public async getNodeId(): Promise<string> {
    if (!this.nodeId) {
      const state = this.store.getState();
      this.nodeId = state.nodeId || crypto.randomUUID();
      this.store.setState({ nodeId: this.nodeId });
    }
    return this.nodeId;
  }

  public async generateAndOpenOptInLink(): Promise<void> {
    const nodeId = await this.getNodeId();
    
    await app.whenReady();
    this.window = new BrowserWindow({
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js')
      }
    });
  
    // Load local opt-in page instead of remote URL
    await this.window.loadFile(path.join(__dirname, 'opt-in.html'));
    
  }

  public async generateSettingsLink(): Promise<string> {
    const nodeId = await this.getNodeId();
    return `https://mellowtel.com/settings?key=${this.publishableKey}&node_id=${nodeId}`;
  }

  public async getOptInStatus(): Promise<boolean> {
    const state = this.store.getState();
    return state.isOptedIn || false;
  }
  public async openSettings(): Promise<void> {
    await app.whenReady();
    
    // Only create new window if one doesn't exist
    if (!this.window) {
      this.window = new BrowserWindow({
        width: 800,
        height: 800,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'preload.js')
        }
      });
  
      this.window.on('closed', () => {
        this.window = null;
      });
  
      await this.window.loadFile(path.join(__dirname, 'settings.html'));
    } else {
      // Focus existing window
      this.window.focus();
    }
  }

  public async start(metadataId?: string): Promise<boolean> {
    if (await this.getOptInStatus()) {
      await this.setupWebSocket();
      this.store.setState({ 
        isStarted: true,
        metadataId 
      });
      return true;
    }
    return false;
  }

  public async stop(): Promise<boolean> {
    if (this.wsClient) {
      this.wsClient.disconnect();
    }
    this.store.setState({ isStarted: false });
    return true;
  }

  public getVersion(): string {
    return VERSION;
  }
}