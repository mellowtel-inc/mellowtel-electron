// src/index.ts
import { app, BrowserWindow, ipcMain } from 'electron';
import { MellowtelStore } from './store';
import { MellowtelConfig, MellowtelState } from './types';
import { VERSION, DEFAULT_MAX_DAILY_RATE, IPC_CHANNELS } from './constants';
import path from 'path';
import { MellowtelWebSocket } from './websocket';

export default class Mellowtel {
  private publishableKey: string;
  private options: any;
  private disableLogs: boolean;
  private MAX_DAILY_RATE: number;
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
    this.disableLogs = options?.disableLogs !== undefined ? options.disableLogs : true;
    this.MAX_DAILY_RATE = options?.MAX_DAILY_RATE || DEFAULT_MAX_DAILY_RATE;
    this.store = new MellowtelStore();
  }

  private log(...args: any[]) {
    if (!this.disableLogs) {
      console.log('[Mellowtel]', ...args);
    }
  }

  private async setupWebSocket() {
    const nodeId = await this.getNodeId();
    this.wsClient = new MellowtelWebSocket(nodeId, this.publishableKey);

    this.wsClient.on('connected', () => {
      this.log('WebSocket connected');
    });

    this.wsClient.on('message', (data) => {
      this.log('Received message:', data);
      // Forward message to renderer if needed
      if (this.window) {
        this.window.webContents.send(IPC_CHANNELS.WS_MESSAGE, data);
      }
    });

    this.wsClient.on('batch', (data, config) => {
      this.log('Batch received:', data, config);
    });

    this.wsClient.connect();
  }

  public async initBackground(autoStartIfOptedIn?: boolean, metadataId?: string): Promise<void> {
    ipcMain.handle(IPC_CHANNELS.GET_STATE, () => {
      return this.store.getState();
    });

    ipcMain.handle(IPC_CHANNELS.UPDATE_SETTINGS, async (_, settings: Partial<MellowtelState>) => {
      this.store.setState(settings);
      if (settings.isOptedIn !== undefined) {
        if (settings.isOptedIn) {
          await this.setupWebSocket();
        } else if (this.wsClient) {
          this.wsClient.disconnect();
        }
      }
    });

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

  public async generateAndOpenOptInLink(): Promise<string> {
    const nodeId = await this.getNodeId();
    const url = `https://mellowtel.com/opt-in?key=${this.publishableKey}&node_id=${nodeId}`;
    
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

    await this.window.loadURL(url);
    return url;
  }

  public async generateSettingsLink(): Promise<string> {
    const nodeId = await this.getNodeId();
    return `https://mellowtel.com/settings?key=${this.publishableKey}&node_id=${nodeId}`;
  }

  public async getOptInStatus(): Promise<boolean> {
    const state = this.store.getState();
    return state.isOptedIn || false;
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