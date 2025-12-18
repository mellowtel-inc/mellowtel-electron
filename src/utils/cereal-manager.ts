import { BrowserWindow } from 'electron';
import { Logger } from '../logger/logger';

/**
 * Optimized Cereal Processing Manager
 * 
 * Key optimizations:
 * 1. Persistent host windows - cereal app loaded once and reused
 * 2. Load balancing - distributes jobs across windows
 * 3. Concurrency control - 25 parallel calls per window (50 total)
 * 4. Memory management - periodic cleanup to prevent leaks
 */

// Configuration
const CEREAL_APP_URL = "https://main.dux9k8u3a1uyw.amplifyapp.com/cereal";
const NUM_HOST_WINDOWS = 2;
const CONCURRENT_CALLS_PER_WINDOW = 25;
const MAX_CEREAL_CONCURRENCY = NUM_HOST_WINDOWS * CONCURRENT_CALLS_PER_WINDOW;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const WINDOW_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes - rotate windows older than this

interface HostWindowInfo {
    window: BrowserWindow;
    activeJobs: number;
    index: number;
    initializationTime: number; // Timestamp when window was created
    needsRotation: boolean; // Flag to mark window for rotation
}

export class CerealManager {
    private static instance: CerealManager;
    private hostWindows: HostWindowInfo[] = [];
    private initialized: boolean = false;
    private cleanupInterval: NodeJS.Timeout | null = null;

    private constructor() {}

    public static getInstance(): CerealManager {
        if (!CerealManager.instance) {
            CerealManager.instance = new CerealManager();
        }
        return CerealManager.instance;
    }

    /**
     * Initialize persistent host windows with cereal app loaded
     */
    public async initialize(): Promise<void> {
        if (this.initialized) {
            Logger.log('[CerealManager] Already initialized');
            return;
        }

        Logger.log(`[CerealManager] Initializing ${NUM_HOST_WINDOWS} host windows...`);
        Logger.log(`[CerealManager] Cereal app URL: ${CEREAL_APP_URL}`);

        for (let i = 0; i < NUM_HOST_WINDOWS; i++) {
            const win = new BrowserWindow({
                show: false,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    offscreen: true,
                }
            });

            // Ensure window is always muted and can never play sound
            win.webContents.setAudioMuted(true);

            // CRITICAL: Prevent window from ever becoming visible
            win.on('show', () => {
                Logger.log(`[CerealManager] Window ${i} attempted to show, hiding it`);
                win.hide();
            });

            // Additional safeguard: Monitor and force hide if window becomes visible
            const visibilityCheck = setInterval(() => {
                if (win && !win.isDestroyed() && win.isVisible()) {
                    Logger.log(`[CerealManager] Window ${i} became visible, hiding it immediately`);
                    win.hide();
                }
            }, 100); // Check every 100ms

            // Clean up interval when window is destroyed
            win.on('closed', () => {
                clearInterval(visibilityCheck);
            });

            // Add console message listener for debugging
            win.webContents.on('console-message', (event, level, message, line, sourceId) => {
                Logger.log(`[CerealManager Window ${i}] ${message}`);
            });

            // Load cereal app once
            await new Promise<void>((resolve, reject) => {
                win.webContents.on('did-finish-load', () => {
                    Logger.log(`[CerealManager] Host window ${i + 1}/${NUM_HOST_WINDOWS} loaded cereal app`);
                    resolve();
                });

                win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
                    Logger.error(`[CerealManager] Failed to load cereal app in window ${i}: ${errorDescription}`);
                    reject(new Error(errorDescription));
                });

                win.loadURL(CEREAL_APP_URL);
            });

            this.hostWindows.push({
                window: win,
                activeJobs: 0,
                index: i,
                initializationTime: Date.now(),
                needsRotation: false
            });
        }

        this.initialized = true;
        Logger.log(`[CerealManager] Ready! Max concurrent jobs: ${MAX_CEREAL_CONCURRENCY}`);
        Logger.log(`[CerealManager] Optimization: Cereal app loaded once per window, reused for all jobs`);

        // Start periodic cleanup
        this.startPeriodicCleanup();
    }

    /**
     * Process a cereal job using the optimized system
     */
    public async processCerealJob(
        cerealObject: string,
        recordID: string,
        htmlContent: string
    ): Promise<any> {
        if (!this.initialized) {
            Logger.log('[CerealManager] Not initialized, initializing now...');
            await this.initialize();
        }

        // Get least busy window for load balancing
        const hostInfo = this.getLeastBusyWindow();
        
        // Check if the selected window is marked for rotation and at/over capacity
        if (hostInfo.needsRotation && hostInfo.activeJobs >= CONCURRENT_CALLS_PER_WINDOW) {
            const error = new Error(`[CerealManager] All healthy windows at capacity. Window ${hostInfo.index} needs rotation but has ${hostInfo.activeJobs} active jobs. Discarding request for ${recordID}.`);
            Logger.error(error.message);
            throw error;
        }
        
        if (hostInfo.activeJobs >= CONCURRENT_CALLS_PER_WINDOW) {
            Logger.log(`[CerealManager] Warning: Window ${hostInfo.index} at capacity (${hostInfo.activeJobs}/${CONCURRENT_CALLS_PER_WINDOW})`);
        }

        // Increment job count
        hostInfo.activeJobs++;
        Logger.log(`[CerealManager] Processing job ${recordID} on window ${hostInfo.index}. Active jobs: ${hostInfo.activeJobs}/${CONCURRENT_CALLS_PER_WINDOW}`);

        try {
            const result = await this.cerealMainV2(
                hostInfo.window,
                recordID,
                htmlContent,
                cerealObject
            );

            // Cleanup after job
            await this.cleanupAfterJob(hostInfo.window);

            return result;
        } finally {
            // Decrement job count
            hostInfo.activeJobs--;
            Logger.log(`[CerealManager] Completed job ${recordID}. Active jobs on window ${hostInfo.index}: ${hostInfo.activeJobs}`);
        }
    }

    /**
     * Get the least busy window for load balancing
     * Also handles window rotation for windows older than 5 minutes
     */
    private getLeastBusyWindow(): HostWindowInfo {
        const now = Date.now();
        
        // First, check if any windows need rotation
        for (const hostInfo of this.hostWindows) {
            const windowAge = now - hostInfo.initializationTime;
            
            // Mark window for rotation if it's older than 5 minutes and not already marked
            if (windowAge > WINDOW_MAX_AGE_MS && !hostInfo.needsRotation) {
                hostInfo.needsRotation = true;
                Logger.log(`[CerealManager] Window ${hostInfo.index} is ${Math.floor(windowAge / 1000)}s old, marked for rotation`);
            }
            
            // If window is marked for rotation and has no active jobs, rotate it now
            if (hostInfo.needsRotation && hostInfo.activeJobs === 0) {
                Logger.log(`[CerealManager] Window ${hostInfo.index} is idle and marked for rotation, rotating now...`);
                this.rotateWindow(hostInfo).catch(err => {
                    Logger.error(`[CerealManager] Error rotating window ${hostInfo.index}: ${err}`);
                });
            }
        }
        
        // Find least busy window among healthy (non-rotating) windows first
        let leastBusy = this.hostWindows[0];
        let hasHealthyWindow = false;
        
        for (const hostInfo of this.hostWindows) {
            if (!hostInfo.needsRotation) {
                hasHealthyWindow = true;
                if (!leastBusy.needsRotation) {
                    // Both are healthy, pick least busy
                    if (hostInfo.activeJobs < leastBusy.activeJobs) {
                        leastBusy = hostInfo;
                    }
                } else {
                    // Current is healthy, previous wasn't
                    leastBusy = hostInfo;
                }
            }
        }
        
        // If no healthy windows available, fall back to least busy rotating window
        // (This will be caught in processCerealJob if at capacity)
        if (!hasHealthyWindow) {
            Logger.log('[CerealManager] Warning: All windows marked for rotation, selecting least busy');
            leastBusy = this.hostWindows[0];
            for (const hostInfo of this.hostWindows) {
                if (hostInfo.activeJobs < leastBusy.activeJobs) {
                    leastBusy = hostInfo;
                }
            }
        }

        return leastBusy;
    }

    /**
     * Rotate a window by destroying it and creating a fresh replacement
     */
    private async rotateWindow(hostInfo: HostWindowInfo): Promise<void> {
        const windowIndex = hostInfo.index;
        Logger.log(`[CerealManager] Rotating window ${windowIndex}...`);

        try {
            // Force destroy the old window (cannot be prevented by page scripts)
            if (!hostInfo.window.isDestroyed()) {
                hostInfo.window.destroy();
            }

            // Create a new window
            const newWin = new BrowserWindow({
                show: false,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    offscreen: true,
                }
            });

            // Ensure window is always muted and can never play sound
            newWin.webContents.setAudioMuted(true);

            // CRITICAL: Prevent window from ever becoming visible
            newWin.on('show', () => {
                Logger.log(`[CerealManager] Window ${windowIndex} attempted to show, hiding it`);
                newWin.hide();
            });

            // Additional safeguard: Monitor and force hide if window becomes visible
            const visibilityCheck = setInterval(() => {
                if (newWin && !newWin.isDestroyed() && newWin.isVisible()) {
                    Logger.log(`[CerealManager] Window ${windowIndex} became visible, hiding it immediately`);
                    newWin.hide();
                }
            }, 100); // Check every 100ms

            // Clean up interval when window is destroyed
            newWin.on('closed', () => {
                clearInterval(visibilityCheck);
            });

            // Add console message listener
            newWin.webContents.on('console-message', (event, level, message, line, sourceId) => {
                Logger.log(`[CerealManager Window ${windowIndex}] ${message}`);
            });

            // Load cereal app
            await new Promise<void>((resolve, reject) => {
                newWin.webContents.on('did-finish-load', () => {
                    Logger.log(`[CerealManager] Window ${windowIndex} rotated successfully`);
                    resolve();
                });

                newWin.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
                    Logger.error(`[CerealManager] Failed to load cereal app in rotated window ${windowIndex}: ${errorDescription}`);
                    reject(new Error(errorDescription));
                });

                newWin.loadURL(CEREAL_APP_URL);
            });

            // Update the host info with new window
            hostInfo.window = newWin;
            hostInfo.initializationTime = Date.now();
            hostInfo.needsRotation = false;
            hostInfo.activeJobs = 0;

            Logger.log(`[CerealManager] Window ${windowIndex} rotation complete`);
        } catch (error) {
            Logger.error(`[CerealManager] Failed to rotate window ${windowIndex}: ${error}`);
            // Mark as not needing rotation to avoid infinite retry loops
            hostInfo.needsRotation = false;
        }
    }

    /**
     * Optimized cereal processing - reuses loaded cereal app
     */
    private async cerealMainV2(
        hostWindow: BrowserWindow,
        recordID: string,
        htmlContent: string,
        cerealObject: string
    ): Promise<any> {
        const timeout = 30000; // 30 seconds

        const mainWork = new Promise((resolve, reject) => {
            // Setup message listener for cereal response
            const responseListener = (event: any, level: number, message: string) => {
                const prefix = 'CEREAL_RESPONSE::';
                if (message.startsWith(prefix)) {
                    try {
                        const response = JSON.parse(message.substring(prefix.length));
                        if (response.recordID === recordID) {
                            Logger.log(`[CerealManager] Received result for ${recordID}`);
                            hostWindow.webContents.removeListener('console-message', responseListener);
                            resolve(response.json);
                        }
                    } catch (e) {
                        Logger.error(`[CerealManager] Error parsing cereal response: ${e}`);
                    }
                }
            };

            hostWindow.webContents.on('console-message', responseListener);

            // Send job to cereal app (already loaded in the window)
            hostWindow.webContents.executeJavaScript(`
                (() => {
                    const message = {
                        type: "PROCESS_DOCUMENT",
                        recordID: "${recordID}",
                        htmlString: ${JSON.stringify(htmlContent)},
                        cerealObject: ${JSON.stringify(typeof cerealObject === "string" ? cerealObject : JSON.stringify(cerealObject))}
                    };
                    
                    const listener = (event) => {
                        if (event.data?.type === 'CEREAL_RESPONSE' && event.data?.recordID === message.recordID) {
                            console.log('CEREAL_RESPONSE::' + JSON.stringify(event.data));
                            window.removeEventListener('message', listener);
                        }
                    };
                    
                    window.addEventListener('message', listener);
                    window.postMessage(message, '*');
                })()
            `).catch(reject);
        });

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Cereal process timed out after ${timeout}ms for ${recordID}`));
            }, timeout);
        });

        return Promise.race([mainWork, timeoutPromise]);
    }

    /**
     * Cleanup after each job to prevent memory buildup
     */
    private async cleanupAfterJob(hostWindow: BrowserWindow): Promise<void> {
        try {
            await hostWindow.webContents.executeJavaScript(`
                (() => {
                    // Clear temporary DOM elements
                    const tempElements = document.querySelectorAll('[data-temp-cereal]');
                    tempElements.forEach(el => el.remove());
                    
                    // Clear large variables from memory
                    if (window.lastProcessedHTML) {
                        delete window.lastProcessedHTML;
                    }
                    if (window.lastCerealResult) {
                        delete window.lastCerealResult;
                    }
                })()
            `);
        } catch (e) {
            Logger.error(`[CerealManager] Error during job cleanup: ${e}`);
        }
    }

    /**
     * Periodic cleanup to prevent memory buildup during idle time
     */
    private startPeriodicCleanup(): void {
        if (this.cleanupInterval) {
            return; // Already running
        }

        this.cleanupInterval = setInterval(async () => {
            try {
                // Only clean up when no jobs are running
                const totalActiveJobs = this.hostWindows.reduce((sum, info) => sum + info.activeJobs, 0);

                if (totalActiveJobs === 0) {
                    Logger.log('[CerealManager] Running periodic memory cleanup on idle windows...');

                    for (const hostInfo of this.hostWindows) {
                        if (!hostInfo.window.isDestroyed()) {
                            await hostInfo.window.webContents.executeJavaScript(`
                                (() => {
                                    // Clear console to reduce memory
                                    console.clear();
                                    
                                    // Force garbage collection if available
                                    if (window.gc) {
                                        window.gc();
                                    }
                                })()
                            `);
                        }
                    }

                    Logger.log('[CerealManager] Periodic cleanup complete');
                }
            } catch (err) {
                Logger.error(`[CerealManager] Error during periodic cleanup: ${err}`);
            }
        }, CLEANUP_INTERVAL_MS);
    }

    /**
     * Get current capacity information
     */
    public getCapacityInfo(): {
        active: number;
        max: number;
        available: number;
        perWindow: Array<{ window: number; active: number; max: number }>;
    } {
        const totalActiveJobs = this.hostWindows.reduce((sum, info) => sum + info.activeJobs, 0);

        return {
            active: totalActiveJobs,
            max: MAX_CEREAL_CONCURRENCY,
            available: MAX_CEREAL_CONCURRENCY - totalActiveJobs,
            perWindow: this.hostWindows.map(info => ({
                window: info.index + 1,
                active: info.activeJobs,
                max: CONCURRENT_CALLS_PER_WINDOW
            }))
        };
    }

    /**
     * Check if we have capacity for more jobs
     */
    public hasCapacity(): boolean {
        if (!this.initialized) {
            return true; // Will initialize on first job
        }

        const totalActiveJobs = this.hostWindows.reduce((sum, info) => sum + info.activeJobs, 0);
        return totalActiveJobs < MAX_CEREAL_CONCURRENCY;
    }

    /**
     * Shutdown and cleanup all resources
     */
    public async shutdown(): Promise<void> {
        Logger.log('[CerealManager] Shutting down...');

        // Stop periodic cleanup
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        // Force destroy all host windows (cannot be prevented by page scripts)
        for (const hostInfo of this.hostWindows) {
            if (!hostInfo.window.isDestroyed()) {
                hostInfo.window.destroy();
            }
        }

        this.hostWindows = [];
        this.initialized = false;

        Logger.log('[CerealManager] Shutdown complete');
    }
}

// Export singleton instance getter
export const getCerealManager = () => CerealManager.getInstance();

// Export configuration constants
export {
    CEREAL_APP_URL,
    NUM_HOST_WINDOWS,
    CONCURRENT_CALLS_PER_WINDOW,
    MAX_CEREAL_CONCURRENCY
};
