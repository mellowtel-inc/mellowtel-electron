import { BrowserWindow } from 'electron';
import { Logger } from '../logger/logger';
import { ObservedError } from '../observability/observed-error';

/**
 * Optimized Cereal Processing Manager
 *
 * Key optimizations:
 * 1. Persistent host windows - cereal app loaded once and reused
 * 2. Load balancing - distributes jobs across windows
 * 3. Concurrency control - 25 parallel calls per window (50 total)
 * 4. Memory management - periodic cleanup to prevent leaks
 *
 * Rotation never runs a job on a window that is being destroyed.
 * Host windows are also monitored for renderer crashes (`render-process-gone`)
 * and the initial page load is time-bounded, so a dead/stuck renderer can't
 * masquerade as healthy or wedge rotation forever.
 * See docs/CEREAL-ROTATION.md.
 */

const CEREAL_APP_URL = "https://main.dux9k8u3a1uyw.amplifyapp.com/cereal";
const NUM_HOST_WINDOWS = 2;
const CONCURRENT_CALLS_PER_WINDOW = 25;
const MAX_CEREAL_CONCURRENCY = NUM_HOST_WINDOWS * CONCURRENT_CALLS_PER_WINDOW;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const WINDOW_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes - rotate windows older than this
const ROTATION_STAGGER_MS = WINDOW_MAX_AGE_MS / NUM_HOST_WINDOWS;
const ROTATION_WAIT_MS = 10_000;
const WINDOW_LOAD_TIMEOUT_MS = 30_000; // bound the initial page load so a stuck load can't wedge rotation forever

interface HostWindowInfo {
    window: BrowserWindow;
    activeJobs: number;
    index: number;
    initializationTime: number;
    rotating: boolean;
    rotation: Promise<void> | null;
}

function isDestroyedError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /object has been destroyed/i.test(message);
}

function cerealFailed(message: string, raw?: unknown, cause?: unknown): ObservedError {
    return new ObservedError(message, {
        code: 'CEREAL_FAILED',
        stage: 'cereal',
        raw,
        cause,
    });
}

export class CerealManager {
    private static instance: CerealManager;
    private hostWindows: HostWindowInfo[] = [];
    private initialized: boolean = false;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private shuttingDown: boolean = false;

    private constructor() {}

    public static getInstance(): CerealManager {
        if (!CerealManager.instance) {
            CerealManager.instance = new CerealManager();
        }
        return CerealManager.instance;
    }

    /**
     * Allow lazy initialization again after a previous shutdown.
     */
    public resume(): void {
        this.shuttingDown = false;
    }

    /**
     * Initialize persistent host windows with cereal app loaded
     */
    public async initialize(): Promise<void> {
        if (this.shuttingDown) {
            throw new Error('[CerealManager] Cannot initialize while shut down');
        }

        if (this.initialized) {
            Logger.log('[CerealManager] Already initialized');
            return;
        }

        Logger.log(`[CerealManager] Initializing ${NUM_HOST_WINDOWS} host windows...`);
        Logger.log(`[CerealManager] Cereal app URL: ${CEREAL_APP_URL}`);

        const created: BrowserWindow[] = [];
        try {
            for (let i = 0; i < NUM_HOST_WINDOWS; i++) {
                if (this.shuttingDown) {
                    throw new Error('[CerealManager] Initialization cancelled during shutdown');
                }

                const win = await this.createHostWindow(i);
                created.push(win);

                this.hostWindows.push({
                    window: win,
                    activeJobs: 0,
                    index: i,
                    // Offset clocks so both slots do not expire in the same tick.
                    initializationTime: Date.now() + i * ROTATION_STAGGER_MS,
                    rotating: false,
                    rotation: null,
                });
            }
        } catch (error) {
            for (const win of created) {
                if (!win.isDestroyed()) {
                    win.destroy();
                }
            }
            this.hostWindows = [];
            throw error;
        }

        this.initialized = true;
        Logger.log(`[CerealManager] Ready! Max concurrent jobs: ${MAX_CEREAL_CONCURRENCY}`);
        Logger.log(`[CerealManager] Optimization: Cereal app loaded once per window, reused for all jobs`);

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
        if (this.shuttingDown) {
            throw new Error('[CerealManager] Cannot accept work while shut down');
        }

        if (!this.initialized) {
            Logger.log('[CerealManager] Not initialized, initializing now...');
            await this.initialize();
        }

        const hostInfo = await this.acquireReadyWindow(recordID);
        const win = hostInfo.window;
        hostInfo.activeJobs++;
        Logger.log(`[CerealManager] Processing job ${recordID} on window ${hostInfo.index}. Active jobs: ${hostInfo.activeJobs}/${CONCURRENT_CALLS_PER_WINDOW}`);

        try {
            if (win.isDestroyed()) {
                throw cerealFailed(`[CerealManager] Window ${hostInfo.index} was destroyed before job ${recordID}`, {
                    recordID,
                    windowIndex: hostInfo.index,
                });
            }

            const result = await this.cerealMainV2(
                win,
                recordID,
                htmlContent,
                cerealObject
            );

            await this.cleanupAfterJob(win);
            return result;
        } catch (error) {
            if (isDestroyedError(error)) {
                throw cerealFailed(`[CerealManager] Window destroyed during job ${recordID}`, {
                    recordID,
                    windowIndex: hostInfo.index,
                }, error);
            }
            throw error;
        } finally {
            hostInfo.activeJobs--;
            Logger.log(`[CerealManager] Completed job ${recordID}. Active jobs on window ${hostInfo.index}: ${hostInfo.activeJobs}`);
            this.kickIdleRotation();
        }
    }

    private async acquireReadyWindow(recordID: string): Promise<HostWindowInfo> {
        const deadline = Date.now() + ROTATION_WAIT_MS;

        while (!this.shuttingDown) {
            this.kickIdleRotation();

            const hostInfo = this.pickReadyWindow();
            if (hostInfo) {
                return hostInfo;
            }

            if (Date.now() >= deadline) {
                throw cerealFailed(`[CerealManager] Timed out waiting ${ROTATION_WAIT_MS}ms for a ready cereal window for ${recordID}`, {
                    recordID,
                    rotating: this.hostWindows.filter(h => h.rotating).map(h => h.index),
                    activeJobs: this.hostWindows.map(h => ({ window: h.index, active: h.activeJobs })),
                });
            }

            const inFlight = this.hostWindows
                .map(h => h.rotation)
                .filter((rotation): rotation is Promise<void> => rotation !== null);

            const idleUnusable = this.hostWindows.find(h =>
                !h.rotating && h.activeJobs === 0 && this.windowNeedsReplace(h)
            );

            if (inFlight.length > 0) {
                Logger.log('[CerealManager] No ready window, waiting for in-flight rotation');
                await Promise.race([
                    Promise.all(inFlight),
                    this.delay(Math.max(0, deadline - Date.now())),
                ]);
                continue;
            }

            if (idleUnusable) {
                Logger.log(`[CerealManager] No ready window, rotating idle window ${idleUnusable.index}`);
                await this.ensureRotation(idleUnusable);
                continue;
            }

            throw cerealFailed(`[CerealManager] All cereal windows are busy. Discarding request for ${recordID}.`, {
                recordID,
                activeJobs: this.hostWindows.map(h => ({ window: h.index, active: h.activeJobs })),
            });
        }

        throw new Error('[CerealManager] Cannot accept work while shut down');
    }

    private pickReadyWindow(): HostWindowInfo | null {
        let leastBusy: HostWindowInfo | null = null;
        for (const hostInfo of this.hostWindows) {
            if (!this.isReady(hostInfo) || hostInfo.activeJobs >= CONCURRENT_CALLS_PER_WINDOW) {
                continue;
            }
            if (!leastBusy || hostInfo.activeJobs < leastBusy.activeJobs) {
                leastBusy = hostInfo;
            }
        }
        return leastBusy;
    }

    private isReady(hostInfo: HostWindowInfo): boolean {
        return !hostInfo.rotating && !hostInfo.window.isDestroyed();
    }

    private isStale(hostInfo: HostWindowInfo): boolean {
        return Date.now() - hostInfo.initializationTime > WINDOW_MAX_AGE_MS;
    }

    private windowNeedsReplace(hostInfo: HostWindowInfo): boolean {
        return hostInfo.window.isDestroyed() || this.isStale(hostInfo);
    }

    /**
     * Rotate at most one idle stale/dead slot. New jobs keep using any other
     * ready window while the replacement loads.
     */
    private kickIdleRotation(): void {
        if (this.shuttingDown) {
            return;
        }
        if (this.hostWindows.some(h => h.rotating)) {
            return;
        }
        const candidate = this.hostWindows.find(h =>
            !h.rotating && h.activeJobs === 0 && this.windowNeedsReplace(h)
        );
        if (!candidate) {
            return;
        }
        Logger.log(`[CerealManager] Window ${candidate.index} is idle and due for rotation, rotating now...`);
        this.ensureRotation(candidate);
    }

    private ensureRotation(hostInfo: HostWindowInfo): Promise<void> {
        if (hostInfo.rotation) {
            return hostInfo.rotation;
        }
        hostInfo.rotating = true;
        const done = this.rotateWindow(hostInfo).finally(() => {
            if (hostInfo.rotation === done) {
                hostInfo.rotation = null;
            }
            hostInfo.rotating = false;
        });
        hostInfo.rotation = done;
        return done;
    }

    /**
     * Load a replacement first, swap it in, then destroy the old window.
     * Never resets activeJobs — that counter only changes in processCerealJob.
     */
    private async rotateWindow(hostInfo: HostWindowInfo): Promise<void> {
        if (this.shuttingDown) {
            return;
        }

        const windowIndex = hostInfo.index;
        Logger.log(`[CerealManager] Rotating window ${windowIndex}...`);
        const oldWin = hostInfo.window;

        try {
            const newWin = await this.createHostWindow(windowIndex);

            if (this.shuttingDown) {
                if (!newWin.isDestroyed()) {
                    newWin.destroy();
                }
                return;
            }

            hostInfo.window = newWin;
            hostInfo.initializationTime = Date.now();

            if (oldWin !== newWin && !oldWin.isDestroyed()) {
                oldWin.destroy();
            }

            Logger.log(`[CerealManager] Window ${windowIndex} rotation complete`);
        } catch (error) {
            Logger.error(`[CerealManager] Failed to rotate window ${windowIndex}: ${error}`);
        }
    }

    private async createHostWindow(index: number): Promise<BrowserWindow> {
        const win = new BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                offscreen: true,
            }
        });

        win.webContents.setAudioMuted(true);

        win.on('show', () => {
            Logger.log(`[CerealManager] Window ${index} attempted to show, hiding it`);
            win.hide();
        });

        const visibilityCheck = setInterval(() => {
            if (win && !win.isDestroyed() && win.isVisible()) {
                Logger.log(`[CerealManager] Window ${index} became visible, hiding it immediately`);
                win.hide();
            }
        }, 100);

        win.on('closed', () => {
            clearInterval(visibilityCheck);
        });

        win.webContents.on('console-message', (_event, _level, message) => {
            Logger.log(`[CerealManager Window ${index}] ${message}`);
        });

        // Detect renderer crashes for the lifetime of this window. isDestroyed()
        // stays false after a renderer crash (only the outer BrowserWindow shell
        // is tracked there), so without this, isReady()/windowNeedsReplace()
        // would keep treating a dead renderer as healthy and route jobs to it.
        win.webContents.on('render-process-gone', (_event, details) => {
            Logger.error(`[CerealManager] Window ${index} render process gone: ${details.reason}`);
            if (!win.isDestroyed()) {
                win.destroy();
            }
        });

        try {
            await new Promise<void>((resolve, reject) => {
                let settled = false;
                let timeoutId: NodeJS.Timeout | undefined;

                const finish = (fn: () => void) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    if (timeoutId) {
                        clearTimeout(timeoutId);
                    }
                    fn();
                };

                // Neither did-finish-load nor did-fail-load is guaranteed to fire
                // (e.g. a renderer crash mid-navigation, or a connection that
                // stalls without a clean network error). Bound the wait so a
                // stuck load fails fast instead of leaving this slot rotating
                // forever, which would otherwise block the *other* window's
                // rotation too (kickIdleRotation only allows one at a time).
                timeoutId = setTimeout(() => {
                    finish(() => reject(new Error(
                        `Timed out after ${WINDOW_LOAD_TIMEOUT_MS}ms loading cereal app in window ${index}`
                    )));
                }, WINDOW_LOAD_TIMEOUT_MS);

                win.webContents.once('did-finish-load', () => {
                    finish(() => {
                        Logger.log(`[CerealManager] Host window ${index + 1}/${NUM_HOST_WINDOWS} loaded cereal app`);
                        resolve();
                    });
                });

                win.webContents.once('did-fail-load', (_event, _errorCode, errorDescription) => {
                    finish(() => {
                        Logger.error(`[CerealManager] Failed to load cereal app in window ${index}: ${errorDescription}`);
                        reject(new Error(errorDescription));
                    });
                });

                win.webContents.once('render-process-gone', (_event, details) => {
                    finish(() => reject(new Error(
                        `Renderer process gone while loading window ${index}: ${details.reason}`
                    )));
                });

                win.loadURL(CEREAL_APP_URL);
            });
        } catch (error) {
            if (!win.isDestroyed()) {
                win.destroy();
            }
            throw error;
        }

        return win;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
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
        let responseListener: ((event: any, level: number, message: string) => void) | undefined;
        let timeoutId: NodeJS.Timeout | undefined;

        if (hostWindow.isDestroyed()) {
            throw cerealFailed(`[CerealManager] Window destroyed before cereal ran for ${recordID}`, { recordID });
        }

        const mainWork = new Promise((resolve, reject) => {
            responseListener = (_event: any, _level: number, message: string) => {
                const prefix = 'CEREAL_RESPONSE::';
                if (message.startsWith(prefix)) {
                    try {
                        const response = JSON.parse(message.substring(prefix.length));
                        if (response.recordID === recordID) {
                            Logger.log(`[CerealManager] Received result for ${recordID}`);
                            resolve(response.json);
                        }
                    } catch (e) {
                        Logger.error(`[CerealManager] Error parsing cereal response: ${e}`);
                    }
                }
            };

            try {
                hostWindow.webContents.on('console-message', responseListener);
            } catch (error) {
                reject(isDestroyedError(error)
                    ? cerealFailed(`[CerealManager] Window destroyed during job ${recordID}`, { recordID }, error)
                    : error);
                return;
            }

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
            timeoutId = setTimeout(() => {
                reject(new ObservedError(`Cereal process timed out after ${timeout}ms for ${recordID}`, {
                    code: 'CEREAL_TIMEOUT',
                    stage: 'cereal',
                    raw: { timeout_ms: timeout, recordID },
                }));
            }, timeout);
        });

        try {
            return await Promise.race([mainWork, timeoutPromise]);
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            if (responseListener && !hostWindow.isDestroyed()) {
                hostWindow.webContents.removeListener('console-message', responseListener);
            }
        }
    }

    /**
     * Cleanup after each job to prevent memory buildup
     */
    private async cleanupAfterJob(hostWindow: BrowserWindow): Promise<void> {
        try {
            if (hostWindow.isDestroyed()) {
                return;
            }
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
            return;
        }

        this.cleanupInterval = setInterval(async () => {
            if (this.shuttingDown) {
                return;
            }

            try {
                this.kickIdleRotation();

                const totalActiveJobs = this.hostWindows.reduce((sum, info) => sum + info.activeJobs, 0);

                if (totalActiveJobs === 0) {
                    Logger.log('[CerealManager] Running periodic memory cleanup on idle windows...');

                    for (const hostInfo of this.hostWindows) {
                        if (hostInfo.rotating || hostInfo.window.isDestroyed()) {
                            continue;
                        }
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
            return true;
        }

        const totalActiveJobs = this.hostWindows.reduce((sum, info) => sum + info.activeJobs, 0);
        return totalActiveJobs < MAX_CEREAL_CONCURRENCY;
    }

    /**
     * Shutdown and cleanup all resources
     */
    public async shutdown(): Promise<void> {
        Logger.log('[CerealManager] Shutting down...');
        this.shuttingDown = true;
        this.initialized = false;

        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        for (const hostInfo of this.hostWindows) {
            if (!hostInfo.window.isDestroyed()) {
                hostInfo.window.destroy();
            }
        }

        this.hostWindows = [];

        Logger.log('[CerealManager] Shutdown complete');
    }
}

export const getCerealManager = () => CerealManager.getInstance();

export {
    CEREAL_APP_URL,
    NUM_HOST_WINDOWS,
    CONCURRENT_CALLS_PER_WINDOW,
    MAX_CEREAL_CONCURRENCY
};
