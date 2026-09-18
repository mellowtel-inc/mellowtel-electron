import { BrowserWindow } from 'electron';
import { Logger } from '../logger/logger';
import { ObservedError } from '../observability/observed-error';

/**
 * Cereal processing manager.
 *
 * One serving window (the cereal SPA, reused for all jobs). During rotation a
 * single replacement may load in the background; jobs stay on the old window
 * until the new one is ready, then the old window is destroyed.
 *
 * Hard caps:
 * - serving slots = 1
 * - live cereal BrowserWindows <= 2 (serving + warming)
 *
 * Extra windows are tracked in ownedWindows and destroyed by trimToCap().
 */

const CEREAL_APP_URL = "https://main.dux9k8u3a1uyw.amplifyapp.com/cereal";
const SERVING_SLOTS = 1;
const MAX_LIVE_CEREAL_WINDOWS = 2;
const CONCURRENT_CALLS_PER_WINDOW = 25;
const MAX_CEREAL_CONCURRENCY = SERVING_SLOTS * CONCURRENT_CALLS_PER_WINDOW;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const WINDOW_MAX_AGE_MS = 5 * 60 * 1000;
const ROTATION_WAIT_MS = 10_000;
const WINDOW_LOAD_TIMEOUT_MS = 30_000;
const JOB_TIMEOUT_MS = 30_000;
const DRAIN_TIMEOUT_MS = JOB_TIMEOUT_MS + 5_000;

/** @deprecated Serving slots. Kept as NUM_HOST_WINDOWS for existing imports. */
const NUM_HOST_WINDOWS = SERVING_SLOTS;

type CreateReason = 'initialize' | 'rotation' | 'crash-replace';

interface HostWindowInfo {
    window: BrowserWindow;
    activeJobs: number;
    index: number;
    initializationTime: number;
    rotating: boolean;
    draining: boolean;
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
    private ownedWindows: Set<BrowserWindow> = new Set();
    private warmingWindow: BrowserWindow | null = null;
    private initialized: boolean = false;
    private initPromise: Promise<void> | null = null;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private shuttingDown: boolean = false;

    private constructor() {}

    public static getInstance(): CerealManager {
        if (!CerealManager.instance) {
            CerealManager.instance = new CerealManager();
        }
        return CerealManager.instance;
    }

    public resume(): void {
        this.shuttingDown = false;
    }

    public async initialize(): Promise<void> {
        if (this.shuttingDown) {
            throw new Error('[CerealManager] Cannot initialize while shut down');
        }

        if (this.initialized) {
            Logger.log('[CerealManager] Already initialized');
            return;
        }

        if (this.initPromise) {
            await this.initPromise;
            return;
        }

        this.initPromise = this.doInitialize().finally(() => {
            this.initPromise = null;
        });
        await this.initPromise;
    }

    private async doInitialize(): Promise<void> {
        if (this.initialized || this.shuttingDown) {
            return;
        }

        this.trimToCap('pre-init');

        const existing = this.servingSlot();
        if (existing && !existing.window.isDestroyed()) {
            this.initialized = true;
            this.startPeriodicCleanup();
            Logger.log('[CerealManager] Reusing existing serving window');
            return;
        }

        Logger.log('[CerealManager] Initializing 1 serving cereal window...');
        Logger.log(`[CerealManager] Cereal app URL: ${CEREAL_APP_URL}`);

        try {
            const win = await this.createHostWindow(0, 'initialize');
            if (this.shuttingDown) {
                this.destroyOwned(win, 'init-shutdown');
                throw new Error('[CerealManager] Initialization cancelled during shutdown');
            }

            this.hostWindows = [{
                window: win,
                activeJobs: 0,
                index: 0,
                initializationTime: Date.now(),
                rotating: false,
                draining: false,
                rotation: null,
            }];

            this.initialized = true;
            this.startPeriodicCleanup();
            this.trimToCap('post-init');
            Logger.log(`[CerealManager] Ready! Max concurrent jobs: ${MAX_CEREAL_CONCURRENCY} (1 serving window, peak ${MAX_LIVE_CEREAL_WINDOWS} live during rotation)`);
        } catch (error) {
            this.initialized = false;
            this.hostWindows = [];
            this.trimToCap('init-failed');
            throw error;
        }
    }

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

        if (this.shuttingDown) {
            throw new Error('[CerealManager] Cannot accept work while shut down');
        }

        this.trimToCap('pre-job');
        const hostInfo = await this.acquireReadyWindow(recordID);
        const win = hostInfo.window;
        hostInfo.activeJobs++;
        Logger.log(`[CerealManager] Processing job ${recordID} on serving window. Active jobs: ${hostInfo.activeJobs}/${CONCURRENT_CALLS_PER_WINDOW}`);

        try {
            if (win.isDestroyed()) {
                throw cerealFailed(`[CerealManager] Serving window was destroyed before job ${recordID}`, {
                    recordID,
                });
            }

            return await this.cerealMainV2(
                win,
                recordID,
                htmlContent,
                cerealObject
            );
        } catch (error) {
            if (isDestroyedError(error)) {
                throw cerealFailed(`[CerealManager] Window destroyed during job ${recordID}`, {
                    recordID,
                }, error);
            }
            throw error;
        } finally {
            hostInfo.activeJobs--;
            Logger.log(`[CerealManager] Completed job ${recordID}. Active jobs: ${hostInfo.activeJobs}`);
            await this.cleanupAfterJob(win);
            this.trimToCap('post-job');
            this.kickIdleRotation();
        }
    }

    private servingSlot(): HostWindowInfo | undefined {
        return this.hostWindows[0];
    }

    private async acquireReadyWindow(recordID: string): Promise<HostWindowInfo> {
        const deadline = Date.now() + ROTATION_WAIT_MS;

        while (!this.shuttingDown) {
            this.trimToCap('acquire');
            this.kickIdleRotation();

            const hostInfo = this.pickReadyWindow();
            if (hostInfo) {
                return hostInfo;
            }

            if (Date.now() >= deadline) {
                throw cerealFailed(`[CerealManager] Timed out waiting ${ROTATION_WAIT_MS}ms for a ready cereal window for ${recordID}`, {
                    recordID,
                    rotating: this.hostWindows.filter(h => h.rotating).map(h => h.index),
                    draining: this.hostWindows.filter(h => h.draining).map(h => h.index),
                    activeJobs: this.hostWindows.map(h => ({ window: h.index, active: h.activeJobs })),
                    live: this.liveCerealCount(),
                    warming: this.warmingWindow !== null && !this.warmingWindow.isDestroyed(),
                });
            }

            const inFlight = this.hostWindows
                .map(h => h.rotation)
                .filter((rotation): rotation is Promise<void> => rotation !== null);

            const serving = this.servingSlot();
            const needsReplace = serving && !serving.rotating && this.windowNeedsReplace(serving);

            if (inFlight.length > 0) {
                Logger.log('[CerealManager] No ready window, waiting for in-flight rotation');
                await Promise.race([
                    Promise.all(inFlight),
                    this.delay(Math.max(0, deadline - Date.now())),
                ]);
                continue;
            }

            if (needsReplace) {
                Logger.log('[CerealManager] No ready window, replacing serving window');
                await this.ensureRotation(serving);
                continue;
            }

            throw cerealFailed(`[CerealManager] Serving cereal window is busy. Discarding request for ${recordID}.`, {
                recordID,
                activeJobs: serving?.activeJobs ?? 0,
            });
        }

        throw new Error('[CerealManager] Cannot accept work while shut down');
    }

    private pickReadyWindow(): HostWindowInfo | null {
        const hostInfo = this.servingSlot();
        if (!hostInfo) {
            return null;
        }
        if (!this.isReady(hostInfo) || hostInfo.activeJobs >= CONCURRENT_CALLS_PER_WINDOW) {
            return null;
        }
        return hostInfo;
    }

    /**
     * Serving stays ready while a replacement is warming. New jobs are blocked
     * only once we drain so we can swap and destroy the old window.
     */
    private isReady(hostInfo: HostWindowInfo): boolean {
        return !hostInfo.draining && !hostInfo.window.isDestroyed();
    }

    private isStale(hostInfo: HostWindowInfo): boolean {
        return Date.now() - hostInfo.initializationTime > WINDOW_MAX_AGE_MS;
    }

    private windowNeedsReplace(hostInfo: HostWindowInfo): boolean {
        return hostInfo.window.isDestroyed() || this.isStale(hostInfo);
    }

    private kickIdleRotation(): void {
        if (this.shuttingDown) {
            return;
        }
        const serving = this.servingSlot();
        if (!serving || serving.rotating) {
            return;
        }
        if (this.warmingWindow && !this.warmingWindow.isDestroyed()) {
            return;
        }
        if (!this.windowNeedsReplace(serving)) {
            return;
        }
        Logger.log('[CerealManager] Serving window due for rotation, warming a replacement...');
        this.ensureRotation(serving);
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
            hostInfo.draining = false;
        });
        hostInfo.rotation = done;
        return done;
    }

    /**
     * Keep serving on the old window while the replacement loads. Drain in-flight
     * jobs, swap, then destroy the old window. Never resets activeJobs.
     */
    private async rotateWindow(hostInfo: HostWindowInfo): Promise<void> {
        if (this.shuttingDown) {
            return;
        }

        const oldWin = hostInfo.window;
        const servingGone = oldWin.isDestroyed();
        const reason: CreateReason = servingGone ? 'crash-replace' : 'rotation';
        Logger.log(`[CerealManager] Rotating serving window (reason=${reason}, live=${this.liveCerealCount()})...`);

        try {
            const newWin = await this.createHostWindow(0, reason);

            if (this.shuttingDown) {
                this.destroyOwned(newWin, 'rotation-shutdown');
                return;
            }

            if (!servingGone && !oldWin.isDestroyed()) {
                hostInfo.draining = true;
                Logger.log('[CerealManager] Replacement loaded, draining in-flight jobs before swap...');
                const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
                while (hostInfo.activeJobs > 0 && Date.now() < drainDeadline && !this.shuttingDown) {
                    await this.delay(50);
                }
            }

            if (this.shuttingDown) {
                this.destroyOwned(newWin, 'rotation-shutdown');
                hostInfo.draining = false;
                return;
            }

            hostInfo.window = newWin;
            hostInfo.initializationTime = Date.now();
            hostInfo.draining = false;
            if (this.warmingWindow === newWin) {
                this.warmingWindow = null;
            }

            if (oldWin !== newWin && !oldWin.isDestroyed()) {
                this.destroyOwned(oldWin, 'rotation-swap');
            }

            Logger.log(`[CerealManager] Rotation complete. live=${this.liveCerealCount()}`);
        } catch (error) {
            Logger.error(`[CerealManager] Failed to rotate serving window: ${error}`);
            hostInfo.draining = false;
            if (this.warmingWindow && !this.warmingWindow.isDestroyed()) {
                this.destroyOwned(this.warmingWindow, 'rotation-failed');
            }
        } finally {
            this.warmingWindow = null;
            this.trimToCap('post-rotation');
        }
    }

    private liveCerealCount(): number {
        let count = 0;
        for (const win of this.ownedWindows) {
            if (!win.isDestroyed()) {
                count++;
            }
        }
        return count;
    }

    private allowedWindows(): Set<BrowserWindow> {
        const allowed = new Set<BrowserWindow>();
        const serving = this.servingSlot();
        if (serving && !serving.window.isDestroyed()) {
            allowed.add(serving.window);
        }
        if (this.warmingWindow && !this.warmingWindow.isDestroyed()) {
            allowed.add(this.warmingWindow);
        }
        return allowed;
    }

    /**
     * Destroy any cereal window that is not the serving window or the single
     * in-flight warming replacement. Also drops extra serving slots.
     */
    private trimToCap(reason: string): void {
        if (this.shuttingDown) {
            return;
        }

        while (this.hostWindows.length > SERVING_SLOTS) {
            const extra = this.hostWindows[this.hostWindows.length - 1];
            if (extra.activeJobs > 0) {
                Logger.log(`[CerealManager] trimToCap(${reason}): extra slot has ${extra.activeJobs} jobs, waiting to destroy`);
                break;
            }
            this.hostWindows.pop();
            if (extra.window && !extra.window.isDestroyed()) {
                this.destroyOwned(extra.window, `trim-extra-slot:${reason}`);
            }
        }

        const allowed = this.allowedWindows();
        for (const win of [...this.ownedWindows]) {
            if (win.isDestroyed()) {
                this.ownedWindows.delete(win);
                if (this.warmingWindow === win) {
                    this.warmingWindow = null;
                }
                continue;
            }
            if (!allowed.has(win)) {
                this.destroyOwned(win, `trim-untracked:${reason}`);
            }
        }

        const live = this.liveCerealCount();
        if (live > MAX_LIVE_CEREAL_WINDOWS) {
            Logger.error(`[CerealManager] live cereal windows ${live} > cap ${MAX_LIVE_CEREAL_WINDOWS} after trim (${reason})`);
            if (this.warmingWindow && !this.warmingWindow.isDestroyed() && allowed.size > SERVING_SLOTS) {
                this.destroyOwned(this.warmingWindow, `trim-over-cap:${reason}`);
            }
        }
    }

    private destroyOwned(win: BrowserWindow, reason: string): void {
        this.ownedWindows.delete(win);
        if (this.warmingWindow === win) {
            this.warmingWindow = null;
        }
        if (win.isDestroyed()) {
            return;
        }
        win.destroy();
        Logger.log(`[CerealManager] Destroyed cereal window (${reason})`);
    }

    private async createHostWindow(_index: number, reason: CreateReason): Promise<BrowserWindow> {
        this.trimToCap(`pre-create:${reason}`);
        const live = this.liveCerealCount();

        if (reason === 'initialize') {
            if (live >= SERVING_SLOTS) {
                throw cerealFailed(`[CerealManager] Hard cap: serving window already exists (live=${live})`, { reason, live });
            }
        } else {
            if (this.warmingWindow && !this.warmingWindow.isDestroyed()) {
                throw cerealFailed(`[CerealManager] Hard cap: warming window already exists (live=${live})`, { reason, live });
            }
            if (live >= MAX_LIVE_CEREAL_WINDOWS) {
                this.trimToCap(`create-cap:${reason}`);
                if (this.liveCerealCount() >= MAX_LIVE_CEREAL_WINDOWS) {
                    throw cerealFailed(`[CerealManager] Hard cap: live cereal windows at ${MAX_LIVE_CEREAL_WINDOWS}`, { reason, live });
                }
            }
        }

        const win = new BrowserWindow({
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                offscreen: true,
            }
        });

        this.ownedWindows.add(win);
        if (reason === 'rotation' || reason === 'crash-replace') {
            this.warmingWindow = win;
        }

        win.webContents.setAudioMuted(true);

        win.on('show', () => {
            Logger.log(`[CerealManager] Cereal window attempted to show (${reason}), hiding it`);
            win.hide();
        });

        const visibilityCheck = setInterval(() => {
            if (win && !win.isDestroyed() && win.isVisible()) {
                Logger.log(`[CerealManager] Cereal window became visible (${reason}), hiding it immediately`);
                win.hide();
            }
        }, 100);

        win.on('closed', () => {
            clearInterval(visibilityCheck);
            this.ownedWindows.delete(win);
            if (this.warmingWindow === win) {
                this.warmingWindow = null;
            }
        });

        win.webContents.on('console-message', (_event, _level, message) => {
            Logger.log(`[CerealManager Window] ${message}`);
        });

        win.webContents.on('render-process-gone', (_event, details) => {
            Logger.error(`[CerealManager] Cereal renderer gone (${reason}): ${details.reason}`);
            const wasServing = this.servingSlot()?.window === win;
            if (!win.isDestroyed()) {
                this.destroyOwned(win, `render-process-gone:${reason}`);
            }
            if (wasServing && !this.shuttingDown) {
                this.kickIdleRotation();
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

                timeoutId = setTimeout(() => {
                    finish(() => reject(new Error(
                        `Timed out after ${WINDOW_LOAD_TIMEOUT_MS}ms loading cereal app (${reason})`
                    )));
                }, WINDOW_LOAD_TIMEOUT_MS);

                win.webContents.once('did-finish-load', () => {
                    finish(() => {
                        Logger.log(`[CerealManager] Cereal app loaded (reason=${reason})`);
                        resolve();
                    });
                });

                win.webContents.once('did-fail-load', (_event, _errorCode, errorDescription) => {
                    finish(() => {
                        Logger.error(`[CerealManager] Failed to load cereal app (${reason}): ${errorDescription}`);
                        reject(new Error(errorDescription));
                    });
                });

                win.webContents.once('render-process-gone', (_event, details) => {
                    finish(() => reject(new Error(
                        `Renderer process gone while loading cereal app (${reason}): ${details.reason}`
                    )));
                });

                win.loadURL(CEREAL_APP_URL);
            });
        } catch (error) {
            this.destroyOwned(win, `load-failed:${reason}`);
            throw error;
        }

        return win;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async cerealMainV2(
        hostWindow: BrowserWindow,
        recordID: string,
        htmlContent: string,
        cerealObject: string
    ): Promise<any> {
        let responseListener: ((event: any, level: number, message: string) => void) | undefined;
        let timeoutId: NodeJS.Timeout | undefined;

        if (hostWindow.isDestroyed()) {
            throw cerealFailed(`[CerealManager] Window destroyed before cereal ran for ${recordID}`, { recordID });
        }

        const cerealObjectJson = typeof cerealObject === "string" ? cerealObject : JSON.stringify(cerealObject);

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
                    const recordID = ${JSON.stringify(recordID)};
                    const message = {
                        type: "PROCESS_DOCUMENT",
                        recordID: recordID,
                        htmlString: ${JSON.stringify(htmlContent)},
                        cerealObject: ${JSON.stringify(cerealObjectJson)}
                    };

                    let done = false;
                    const listener = (event) => {
                        if (done) return;
                        if (event.data?.type === 'CEREAL_RESPONSE' && event.data?.recordID === recordID) {
                            done = true;
                            clearTimeout(tid);
                            window.removeEventListener('message', listener);
                            console.log('CEREAL_RESPONSE::' + JSON.stringify(event.data));
                        }
                    };

                    const tid = setTimeout(() => {
                        if (done) return;
                        done = true;
                        window.removeEventListener('message', listener);
                    }, ${JOB_TIMEOUT_MS});

                    window.addEventListener('message', listener);
                    window.postMessage(message, '*');
                })()
            `).catch(reject);
        });

        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new ObservedError(`Cereal process timed out after ${JOB_TIMEOUT_MS}ms for ${recordID}`, {
                    code: 'CEREAL_TIMEOUT',
                    stage: 'cereal',
                    raw: { timeout_ms: JOB_TIMEOUT_MS, recordID },
                }));
            }, JOB_TIMEOUT_MS);
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

    private async cleanupAfterJob(hostWindow: BrowserWindow): Promise<void> {
        try {
            if (hostWindow.isDestroyed()) {
                return;
            }
            await hostWindow.webContents.executeJavaScript(`
                (() => {
                    const tempElements = document.querySelectorAll('[data-temp-cereal]');
                    tempElements.forEach(el => el.remove());
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

    private startPeriodicCleanup(): void {
        if (this.cleanupInterval) {
            return;
        }

        this.cleanupInterval = setInterval(async () => {
            if (this.shuttingDown) {
                return;
            }

            try {
                this.trimToCap('periodic');
                this.kickIdleRotation();

                const serving = this.servingSlot();
                if (serving && serving.activeJobs === 0 && !serving.rotating && !serving.window.isDestroyed()) {
                    Logger.log('[CerealManager] Running periodic memory cleanup on idle serving window...');
                    await serving.window.webContents.executeJavaScript(`
                        (() => {
                            console.clear();
                            if (window.gc) {
                                window.gc();
                            }
                        })()
                    `);
                    Logger.log('[CerealManager] Periodic cleanup complete');
                }
            } catch (err) {
                Logger.error(`[CerealManager] Error during periodic cleanup: ${err}`);
            }
        }, CLEANUP_INTERVAL_MS);
    }

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

    public hasCapacity(): boolean {
        if (!this.initialized) {
            return true;
        }

        const totalActiveJobs = this.hostWindows.reduce((sum, info) => sum + info.activeJobs, 0);
        return totalActiveJobs < MAX_CEREAL_CONCURRENCY;
    }

    public async shutdown(): Promise<void> {
        Logger.log('[CerealManager] Shutting down...');
        this.shuttingDown = true;
        this.initialized = false;
        this.initPromise = null;

        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        if (this.warmingWindow && !this.warmingWindow.isDestroyed()) {
            this.destroyOwned(this.warmingWindow, 'shutdown');
        }

        for (const hostInfo of this.hostWindows) {
            if (hostInfo.window && !hostInfo.window.isDestroyed()) {
                this.destroyOwned(hostInfo.window, 'shutdown');
            }
        }

        for (const win of [...this.ownedWindows]) {
            this.destroyOwned(win, 'shutdown-owned');
        }

        this.hostWindows = [];
        this.ownedWindows.clear();
        this.warmingWindow = null;

        Logger.log('[CerealManager] Shutdown complete');
    }
}

export const getCerealManager = () => CerealManager.getInstance();

export {
    CEREAL_APP_URL,
    NUM_HOST_WINDOWS,
    CONCURRENT_CALLS_PER_WINDOW,
    MAX_CEREAL_CONCURRENCY,
    MAX_LIVE_CEREAL_WINDOWS
};
