// src/store.ts
import Store from 'electron-store';
import { EventEmitter } from 'events';
import { MellowtelState } from './types';
import { VERSION } from './constants';

interface StoreSchema {
  isOptedIn: boolean;
  isStarted: boolean;
  nodeId: string;
  publishableKey: string;
  metadataId?: string;
  rateLimitData: {
    count: number;
    timestamp: number;
    isLimited: boolean;
  };
  lastUpdated: number;
  version: string;
}

export class MellowtelStore extends EventEmitter {
  private store: Store<StoreSchema>;

  constructor() {
    super();
    
    this.store = new Store<StoreSchema>({
      name: 'mellowtel-settings',
      defaults: {
        isOptedIn: false,
        isStarted: false,
        nodeId: '',
        publishableKey: '',
        rateLimitData: {
          count: 0,
          timestamp: Date.now(),
          isLimited: false
        },
        lastUpdated: Date.now(),
        version: VERSION
      },
      schema: {
        isOptedIn: {
          type: 'boolean'
        },
        isStarted: {
          type: 'boolean'
        },
        nodeId: {
          type: 'string'
        },
        publishableKey: {
          type: 'string'
        },
        metadataId: {
          type: 'string',
        },
        rateLimitData: {
          type: 'object',
          properties: {
            count: {
              type: 'number',
              minimum: 0
            },
            timestamp: {
              type: 'number'
            },
            isLimited: {
              type: 'boolean'
            }
          }
        },
        lastUpdated: {
          type: 'number'
        },
        version: {
          type: 'string'
        }
      }
    });

    // Set up watchers for key state changes
    this.setupWatchers();
  }

  private setupWatchers() {
    this.store.onDidChange('isOptedIn', (newValue, oldValue) => {
        if (typeof newValue === 'boolean' && newValue !== oldValue) {
          this.emit('opt-in:changed', newValue);
        }
      });

    this.store.onDidChange('isStarted', (newValue, oldValue) => {
      if (typeof newValue === 'boolean' && newValue !== oldValue) {
        this.emit('status:changed', newValue);
      }
    });
  }

  public getState(): MellowtelState {
    const state = this.store.store;
    return {
      isOptedIn: state.isOptedIn,
      isStarted: state.isStarted,
      nodeId: state.nodeId,
      publishableKey: state.publishableKey,
      metadataId: state.metadataId
    };
  }

  public setState(state: Partial<MellowtelState>) {
    Object.entries(state).forEach(([key, value]) => {
      if (value !== undefined) {
        this.store.set(key as keyof StoreSchema, value);
      }
    });
    this.store.set('lastUpdated', Date.now());
  }

  public getRateLimit() {
    return this.store.get('rateLimitData');
  }

  public updateRateLimit(count: number, isLimited: boolean) {
    this.store.set('rateLimitData', {
      count,
      timestamp: Date.now(),
      isLimited
    });
  }

  public clear() {
    this.store.clear();
    this.store.set({
      isOptedIn: false,
      isStarted: false,
      nodeId: '',
      publishableKey: '',
      rateLimitData: {
        count: 0,
        timestamp: Date.now(),
        isLimited: false
      },
      lastUpdated: Date.now(),
      version: VERSION
    });
  }

  // Helper methods for common operations
  public isOptedIn(): boolean {
    return this.store.get('isOptedIn', false);
  }

  public isStarted(): boolean {
    return this.store.get('isStarted', false);
  }

  public getNodeId(): string {
    return this.store.get('nodeId', '');
  }

  public getPublishableKey(): string {
    return this.store.get('publishableKey', '');
  }

  public getMetadataId(): string | undefined {
    return this.store.get('metadataId');
  }

  public setMetadataId(id: string | undefined) {
    if (id) {
      this.store.set('metadataId', id);
    } else {
      this.store.delete('metadataId');
    }
  }
}

// Type declaration for event emitter
export declare interface MellowtelStore {
    on(event: 'opt-in:changed', listener: (isOptedIn: boolean) => void): this;
    on(event: 'status:changed', listener: (isStarted: boolean) => void): this;
    emit(event: 'opt-in:changed', isOptedIn: boolean): boolean;
    emit(event: 'status:changed', isStarted: boolean): boolean;
  }