import { BrowserWindow, session } from 'electron';
import { Logger } from '../logger/logger';
import * as os from 'os';

/**
 * Window Pool Manager
 * 
 * Manages a pool of reusable BrowserWindows to prevent unbounded window creation.
 * Key features:
 * 1. Pool of reusable windows (default: 10 windows)
 * 2. Concurrency control (max 5-10 concurrent operations)
 * 3. Automatic cleanup and window recycling
 * 4. Memory leak prevention
 * 5. Window health monitoring and rotation
 */

interface PooledWindow {
    window: BrowserWindow;
    id: string;
    inUse: boolean;
    createdAt: number;
    usageCount: number;
    lastUsedAt: number;
    needsRotation: boolean; // Flag to mark window for rotation when it becomes idle
}

interface WindowPoolConfig {
    poolSize: number;
    maxConcurrency: number;
    maxWindowAge: number; // milliseconds
    maxWindowUsage: number; // number of times a window can be reused
    cleanupInterval: number; // milliseconds
}

/**
 * Calculate optimal pool size based on available system RAM
 * Each Electron window uses approximately 100-150MB of RAM
 */
function calculateOptimalPoolSize(): number {
    try {
        const totalMemoryGB = os.totalmem() / (1024 * 1024 * 1024);

        // Conservative estimates based on available RAM
        if (totalMemoryGB < 4) {
            return 2; // Low RAM devices (< 4GB): 2 windows
        } else if (totalMemoryGB < 8) {
            return 3; // Medium RAM devices (4-8GB): 3 windows
        } else if (totalMemoryGB < 16) {
            return 5; // Good RAM devices (8-16GB): 5 windows
        } else {
            return 8; // High RAM devices (16GB+): 8 windows
        }
    } catch {
        return 4;
    }

}

const DEFAULT_CONFIG: WindowPoolConfig = {
    poolSize: calculateOptimalPoolSize(),
    maxConcurrency: calculateOptimalPoolSize(), // Match pool size
    maxWindowAge: 5 * 60 * 1000, // 5 minutes
    maxWindowUsage: 50, // recycle after 50 uses
    cleanupInterval: 2 * 60 * 1000, // 2 minutes
};

export class WindowPool {
    private static instance: WindowPool;
    private pool: PooledWindow[] = [];
    private config: WindowPoolConfig;
    private limit: any;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private initialized: boolean = false;
    private creatingWindow: boolean = false; // Lock to prevent concurrent window creation

    private constructor(config: Partial<WindowPoolConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    public static getInstance(config?: Partial<WindowPoolConfig>): WindowPool {
        if (!WindowPool.instance) {
            WindowPool.instance = new WindowPool(config);
        }
        return WindowPool.instance;
    }

    /**
     * Initialize the window pool
     */
    public async initialize(): Promise<void> {
        if (this.initialized) {
            Logger.log('[WindowPool] Already initialized');
            return;
        }

        Logger.log(`[WindowPool] Initializing pool with ${this.config.poolSize} windows, max concurrency: ${this.config.maxConcurrency}`);

        // Dynamically import p-limit (ES Module)
        // Use Function constructor to prevent TypeScript from transforming the import
        const pLimit = (await (new Function('specifier', 'return import(specifier)')('p-limit') as Promise<any>)).default;
        this.limit = pLimit(this.config.maxConcurrency);

        // Create initial pool of windows
        for (let i = 0; i < this.config.poolSize; i++) {
            await this.createPooledWindow();
        }

        this.initialized = true;
        this.startPeriodicCleanup();

        Logger.log(`[WindowPool] Initialized successfully. Pool size: ${this.pool.length}`);
    }

    /**
     * Create a new pooled window
     */
    private async createPooledWindow(): Promise<PooledWindow> {
        const windowId = `window-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Create unique session for each window
        const uniqueSession = session.fromPartition(`pool-${windowId}`);

        // Prevent downloads from being saved to disk
        uniqueSession.on('will-download', (event, item, webContents) => {
            Logger.log(`[WindowPool] Download blocked in ${windowId}`);
            event.preventDefault();
        });

        // Set up stealth headers ONCE for this window's session
        // This prevents accumulating listeners on every request
        const platform = os.platform();
        uniqueSession.webRequest.onBeforeSendHeaders((details, callback) => {
            const headers = {
                ...details.requestHeaders,
                'Referer': 'https://www.google.com/',
                'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="139", "Google Chrome";v="139"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': platform === 'win32' ? '"Windows"' : '"macOS"',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'cross-site',
                'sec-fetch-user': '?1',
                'upgrade-insecure-requests': '1',
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'accept-language': 'en-US,en;q=0.9',
                'accept-encoding': 'gzip, deflate, br, zstd',
                'cache-control': 'max-age=0'
            };

            callback({ requestHeaders: headers });
        });

        const win = new BrowserWindow({
            show: false,
            width: 1709,
            height: 984,
            webPreferences: {
                offscreen: true,
                nodeIntegration: false,
                contextIsolation: true,
                session: uniqueSession,
                webSecurity: true,
                allowRunningInsecureContent: false,
                experimentalFeatures: false
            }
        });

        // Ensure window is always muted and can never play sound
        win.webContents.setAudioMuted(true);

        // CRITICAL: Prevent window from ever becoming visible
        win.on('show', () => {
            Logger.log(`[WindowPool] Window ${windowId} attempted to show, hiding it`);
            win.hide();
        });

        // Additional safeguard: Monitor and force hide if window becomes visible
        const visibilityCheck = setInterval(() => {
            if (win && !win.isDestroyed() && win.isVisible()) {
                Logger.log(`[WindowPool] Window ${windowId} became visible, hiding it immediately`);
                win.hide();
            }
        }, 100); // Check every 100ms

        // Clean up interval when window is destroyed
        win.on('closed', () => {
            clearInterval(visibilityCheck);
        });

        // Set OS-specific user agent ONCE for this window
        const userAgent = platform === 'win32'
            ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
            : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

        win.webContents.setUserAgent(userAgent);

        // Add error handling
        win.webContents.on('render-process-gone', (event, details) => {
            Logger.error(`[WindowPool] Window ${windowId} render process gone: ${details.reason}`);
            this.removeWindowFromPool(windowId);
        });

        win.on('unresponsive', () => {
            Logger.error(`[WindowPool] Window ${windowId} became unresponsive`);
        });

        const pooledWindow: PooledWindow = {
            window: win,
            id: windowId,
            inUse: false,
            createdAt: Date.now(),
            usageCount: 0,
            lastUsedAt: Date.now(),
            needsRotation: false
        };

        this.pool.push(pooledWindow);
        Logger.log(`[WindowPool] Created window ${windowId}. Pool size: ${this.pool.length}`);

        return pooledWindow;
    }

    /**
     * Acquire a window from the pool with timeout
     */
    private async acquireWindow(startTime: number = Date.now()): Promise<PooledWindow> {
        if (!this.initialized) {
            await this.initialize();
        }

        // Check if we've exceeded the 50-second timeout
        const elapsedTime = Date.now() - startTime;
        if (elapsedTime > 50000) {
            const error = new Error('[WindowPool] Timeout: No window became available within 50 seconds');
            Logger.error(error.message);
            throw error;
        }

        // Clean up any destroyed windows from the pool first
        const destroyedWindows = this.pool.filter(pw => pw.window.isDestroyed());
        for (const pw of destroyedWindows) {
            Logger.log(`[WindowPool] Removing destroyed window ${pw.id} from pool during acquisition`);
            this.removeWindowFromPool(pw.id);
        }

        // Find an available window that is not destroyed and not marked for rotation
        // Prefer healthy windows over those marked for rotation
        let pooledWindow = this.pool.find(pw => !pw.inUse && !pw.window.isDestroyed() && !pw.needsRotation);
        
        // If no healthy window available, try windows marked for rotation (they're still usable until rotated)
        if (!pooledWindow) {
            pooledWindow = this.pool.find(pw => !pw.inUse && !pw.window.isDestroyed());
        }

        // If no available window, check if we can create a new one
        if (!pooledWindow) {
            const healthyWindows = this.pool.filter(pw => !pw.window.isDestroyed());

            if (healthyWindows.length < this.config.poolSize && !this.creatingWindow) {
                // Use lock to prevent concurrent window creation
                this.creatingWindow = true;
                try {
                    // Double-check after acquiring lock
                    const currentHealthyWindows = this.pool.filter(pw => !pw.window.isDestroyed());
                    if (currentHealthyWindows.length < this.config.poolSize) {
                        Logger.log('[WindowPool] No available windows, creating new one');
                        pooledWindow = await this.createPooledWindow();
                    }
                } finally {
                    this.creatingWindow = false;
                }

                // If we still don't have a window after creation attempt, retry
                if (!pooledWindow) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    return this.acquireWindow(startTime);
                }
            } else {
                // Wait for a window to become available or for creation lock to be released
                const remainingTime = 50000 - elapsedTime;
                Logger.log(`[WindowPool] All windows in use, waiting for one to become available... (${Math.floor(remainingTime / 1000)}s remaining)`);
                await new Promise(resolve => setTimeout(resolve, 100));
                return this.acquireWindow(startTime); // Retry with original start time
            }
        }

        // Mark window for rotation if needed (but don't rotate now - it's about to be used)
        // The window will be rotated when it's released back to the pool
        if (this.shouldRotateWindow(pooledWindow) && !pooledWindow.needsRotation) {
            pooledWindow.needsRotation = true;
            Logger.log(`[WindowPool] Window ${pooledWindow.id} marked for rotation (will rotate after use)`);
        }

        // Final safety check before marking as in use
        if (pooledWindow.window.isDestroyed()) {
            Logger.error(`[WindowPool] Window ${pooledWindow.id} was destroyed just before acquisition, retrying...`);
            this.removeWindowFromPool(pooledWindow.id);
            await new Promise(resolve => setTimeout(resolve, 100));
            return this.acquireWindow(startTime);
        }

        pooledWindow.inUse = true;
        pooledWindow.usageCount++;
        pooledWindow.lastUsedAt = Date.now();

        Logger.log(`[WindowPool] Acquired window ${pooledWindow.id}. Usage count: ${pooledWindow.usageCount}`);

        return pooledWindow;
    }

    /**
     * Release a window back to the pool
     */
    private async releaseWindow(pooledWindow: PooledWindow): Promise<void> {
        if (pooledWindow.window.isDestroyed()) {
            Logger.log(`[WindowPool] Window ${pooledWindow.id} was destroyed, removing from pool`);
            this.removeWindowFromPool(pooledWindow.id);
            // Create a replacement window to maintain pool size
            if (this.pool.length < this.config.poolSize && !this.creatingWindow) {
                this.creatingWindow = true;
                try {
                    await this.createPooledWindow();
                } finally {
                    this.creatingWindow = false;
                }
            }
            return;
        }

        // Mark as not in use first
        pooledWindow.inUse = false;
        pooledWindow.lastUsedAt = Date.now();

        // If window is marked for rotation, rotate it now (it's idle)
        if (pooledWindow.needsRotation) {
            Logger.log(`[WindowPool] Window ${pooledWindow.id} is idle and marked for rotation, rotating now...`);
            await this.rotateWindow(pooledWindow);
            return;
        }

        // Clean up the window before releasing back to pool
        try {
            await this.cleanupWindow(pooledWindow.window);
        } catch (error) {
            Logger.error(`[WindowPool] Error cleaning up window ${pooledWindow.id}: ${error}`);
            // If cleanup fails, the window might be in a bad state - remove it
            if (pooledWindow.window.isDestroyed()) {
                this.removeWindowFromPool(pooledWindow.id);
                return;
            }
        }

        Logger.log(`[WindowPool] Released window ${pooledWindow.id}`);
    }

    /**
     * Execute a task with a pooled window (with concurrency control)
     */
    public async executeWithWindow<T>(
        task: (window: BrowserWindow) => Promise<T>
    ): Promise<T> {
        // Ensure pool is initialized before using this.limit
        if (!this.initialized) {
            await this.initialize();
        }

        return this.limit(async () => {
            const pooledWindow = await this.acquireWindow();

            try {
                // Double-check window is not destroyed before executing task
                if (pooledWindow.window.isDestroyed()) {
                    throw new Error(`[WindowPool] Window ${pooledWindow.id} was destroyed before task execution`);
                }

                const result = await task(pooledWindow.window);
                return result;
            } catch (error) {
                // If the error is about a destroyed window, remove it from the pool
                if (error instanceof Error && error.message.includes('Object has been destroyed')) {
                    Logger.error(`[WindowPool] Window ${pooledWindow.id} was destroyed during task execution`);
                    this.removeWindowFromPool(pooledWindow.id);
                }
                throw error;
            } finally {
                await this.releaseWindow(pooledWindow);
            }
        });
    }

    /**
     * Check if a window should be rotated
     */
    private shouldRotateWindow(pooledWindow: PooledWindow): boolean {
        const age = Date.now() - pooledWindow.createdAt;

        return (
            age > this.config.maxWindowAge ||
            pooledWindow.usageCount >= this.config.maxWindowUsage
        );
    }

    /**
     * Rotate a window (destroy and recreate)
     * Only call this when the window is NOT in use
     */
    private async rotateWindow(pooledWindow: PooledWindow): Promise<void> {
        // Safety check: never rotate a window that's in use
        if (pooledWindow.inUse) {
            Logger.error(`[WindowPool] Attempted to rotate window ${pooledWindow.id} while in use - skipping`);
            return;
        }

        Logger.log(`[WindowPool] Rotating window ${pooledWindow.id} (age: ${Math.floor((Date.now() - pooledWindow.createdAt) / 1000)}s, usage: ${pooledWindow.usageCount})`);

        const index = this.pool.indexOf(pooledWindow);
        if (index === -1) {
            Logger.log(`[WindowPool] Window ${pooledWindow.id} not found in pool, skipping rotation`);
            return;
        }

        // Destroy old window
        if (!pooledWindow.window.isDestroyed()) {
            pooledWindow.window.destroy();
        }

        // Remove from pool
        this.pool.splice(index, 1);

        // Create new window
        await this.createPooledWindow();

        Logger.log(`[WindowPool] Window rotation complete`);
    }

    /**
     * Remove a window from the pool
     */
    private removeWindowFromPool(windowId: string): void {
        const index = this.pool.findIndex(pw => pw.id === windowId);
        if (index !== -1) {
            const pooledWindow = this.pool[index];
            if (!pooledWindow.window.isDestroyed()) {
                pooledWindow.window.destroy();
            }
            this.pool.splice(index, 1);
            Logger.log(`[WindowPool] Removed window ${windowId}. Pool size: ${this.pool.length}`);
        }
    }

    /**
     * Clean up a window after use
     */
    private async cleanupWindow(window: BrowserWindow): Promise<void> {
        if (window.isDestroyed()) {
            throw new Error('Cannot cleanup destroyed window');
        }

        try {
            // Clear any loaded content
            if (!window.isDestroyed()) {
                await window.webContents.executeJavaScript(`
                    (() => {
                        // Clear document
                        if (document.body) {
                            document.body.innerHTML = '';
                        }
                        
                        // Clear any timers
                        const highestTimeoutId = setTimeout(() => {}, 0);
                        for (let i = 0; i < highestTimeoutId; i++) {
                            clearTimeout(i);
                        }
                        
                        const highestIntervalId = setInterval(() => {}, 9999);
                        for (let i = 0; i < highestIntervalId; i++) {
                            clearInterval(i);
                        }
                        
                        // Clear console
                        console.clear();
                    })()
                `).catch(err => {
                    if (!window.isDestroyed()) {
                        Logger.error(`[WindowPool] Error during window cleanup: ${err}`);
                    }
                });
            }

            // Load blank page to reset state
            if (!window.isDestroyed()) {
                await window.loadURL('about:blank').catch(err => {
                    if (!window.isDestroyed()) {
                        Logger.error(`[WindowPool] Error loading blank page: ${err}`);
                    }
                });
            }
        } catch (error) {
            if (!window.isDestroyed()) {
                Logger.error(`[WindowPool] Error cleaning up window: ${error}`);
            }
            throw error;
        }
    }

    /**
     * Periodic cleanup to maintain pool health
     */
    private startPeriodicCleanup(): void {
        if (this.cleanupInterval) {
            return;
        }

        this.cleanupInterval = setInterval(async () => {
            Logger.log('[WindowPool] Running periodic cleanup...');

            const now = Date.now();
            const windowsToRotate: PooledWindow[] = [];

            // Find windows that need rotation and are not in use
            for (const pooledWindow of this.pool) {
                if (!pooledWindow.inUse && this.shouldRotateWindow(pooledWindow)) {
                    windowsToRotate.push(pooledWindow);
                }
            }

            // Rotate windows
            for (const pooledWindow of windowsToRotate) {
                await this.rotateWindow(pooledWindow);
            }

            // Remove destroyed windows
            const destroyedWindows = this.pool.filter(pw => pw.window.isDestroyed());
            for (const pooledWindow of destroyedWindows) {
                this.removeWindowFromPool(pooledWindow.id);
            }

            // Ensure we maintain minimum pool size (respect creation lock)
            while (this.pool.length < this.config.poolSize && !this.creatingWindow) {
                this.creatingWindow = true;
                try {
                    // Double-check after acquiring lock
                    if (this.pool.length < this.config.poolSize) {
                        await this.createPooledWindow();
                    }
                } finally {
                    this.creatingWindow = false;
                }
            }

            Logger.log(`[WindowPool] Periodic cleanup complete. Pool size: ${this.pool.length}, In use: ${this.pool.filter(pw => pw.inUse).length}`);
        }, this.config.cleanupInterval);
    }

    /**
     * Get pool statistics
     */
    public getStats(): {
        poolSize: number;
        inUse: number;
        available: number;
        maxConcurrency: number;
        windows: Array<{
            id: string;
            inUse: boolean;
            age: number;
            usageCount: number;
        }>;
    } {
        return {
            poolSize: this.pool.length,
            inUse: this.pool.filter(pw => pw.inUse).length,
            available: this.pool.filter(pw => !pw.inUse).length,
            maxConcurrency: this.config.maxConcurrency,
            windows: this.pool.map(pw => ({
                id: pw.id,
                inUse: pw.inUse,
                age: Date.now() - pw.createdAt,
                usageCount: pw.usageCount
            }))
        };
    }

    /**
     * Shutdown the pool and cleanup all resources
     */
    public async shutdown(): Promise<void> {
        Logger.log('[WindowPool] Shutting down...');

        // Stop periodic cleanup
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        // Destroy all windows
        for (const pooledWindow of this.pool) {
            if (!pooledWindow.window.isDestroyed()) {
                pooledWindow.window.destroy();
            }
        }

        this.pool = [];
        this.initialized = false;

        Logger.log('[WindowPool] Shutdown complete');
    }
}

// Export singleton getter
export const getWindowPool = (config?: Partial<WindowPoolConfig>) => WindowPool.getInstance(config);
