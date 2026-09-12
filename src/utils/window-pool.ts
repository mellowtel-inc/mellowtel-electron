import { BrowserWindow, session, app, Session } from 'electron';
import { Logger } from '../logger/logger';
import { ObservedError } from '../observability/observed-error';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import pLimit from 'p-limit';
import { DIALOG_BLOCK_SOURCE } from './dialog-block-source';
import { attachClientHeaderHook, getDeviceClient } from './client';

// Preload that stubs alert/confirm/prompt before page scripts run (fixes
// Windows dialog leak). DIALOG_BLOCK_SOURCE is a string constant imported
// from ./dialog-block-source.ts; we write it to userData on first use and
// hand Electron the resulting file path. Going through a string + runtime
// write avoids any __dirname / relative-file resolution, so the fix works
// even when host apps bundle their main process (webpack, vite, esbuild).
let cachedDialogPreloadPath: string | null = null;

export function getDialogBlockPreloadPath(): string {
    if (cachedDialogPreloadPath) {
        return cachedDialogPreloadPath;
    }
    const hash = crypto.createHash('sha1').update(DIALOG_BLOCK_SOURCE).digest('hex').slice(0, 12);
    const dir = path.join(app.getPath('userData'), 'mellowtel-preload');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `dialog-block-${hash}.js`);
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, DIALOG_BLOCK_SOURCE, 'utf8');
        Logger.log(`[WindowPool] Wrote dialog-block preload to ${filePath}`);
    }
    cachedDialogPreloadPath = filePath;
    return filePath;
}

/**
 * Window Pool Manager
 *
 * Manages a pool of reusable BrowserWindows to prevent unbounded window creation.
 * Key features:
 * 1. Pool of reusable windows (default: 2 windows - see DEFAULT_MAX_WINDOWS)
 * 2. Concurrency control, overridable per request (DataRequest.maxWindows)
 * 3. Automatic cleanup and window recycling
 * 4. Memory leak prevention
 * 5. Window health monitoring and rotation
 */

interface PooledWindow {
    window: BrowserWindow;
    session: Session; // the reusable per-slot session backing this window
    slot: number;     // fixed slot index (0..poolSize-1) that owns the session
    id: string;
    inUse: boolean;
    createdAt: number;
    usageCount: number;
    lastUsedAt: number;
    needsRotation: boolean; // Flag to mark window for rotation when it becomes idle
}

export interface WindowPoolConfig {
    poolSize: number;
    maxConcurrency: number;
    maxWindowAge: number; // milliseconds
    maxWindowUsage: number; // number of times a window can be reused
    cleanupInterval: number; // milliseconds
}

// How many Chromium windows this app may have open for scraping at once.
// No RAM-based auto-sizing: a single fixed default, overridable per request
// via DataRequest.maxWindows (see getWindowPool in data-helpers.ts). This is
// a deliberate throughput ceiling, not a resource limit.
const DEFAULT_MAX_WINDOWS = 2;

const DEFAULT_CONFIG: WindowPoolConfig = {
    poolSize: DEFAULT_MAX_WINDOWS,
    maxConcurrency: DEFAULT_MAX_WINDOWS, // Match pool size
    maxWindowAge: 5 * 60 * 1000, // 5 minutes
    maxWindowUsage: 50, // recycle after 50 uses
    cleanupInterval: 2 * 60 * 1000, // 2 minutes
};

/** A positive integer, or undefined for anything else (including NaN/0/negative). */
function sanitizePositiveInt(value: unknown): number | undefined {
    return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

export class WindowPool {
    private static instance: WindowPool;
    private pool: PooledWindow[] = [];
    private config: WindowPoolConfig;
    private limit: any;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private initialized: boolean = false;
    private creatingWindow: boolean = false; // Lock to prevent concurrent window creation
    private initializingPromise: Promise<void> | null = null; // Lock to prevent concurrent initialize() calls
    private shuttingDown: boolean = false;
    private crashHandlersInitialized: boolean = false;
    // Fixed set of session slots. Each live window owns one slot; its session is
    // session.fromPartition(`mellowtel-pool-slot-<slot>`). Reusing a bounded set of
    // partition names caps the number of Electron sessions (and their network
    // contexts, which hold OS threads + Mach ports) at poolSize, which is the core
    // fix for the handle/port leak.
    private freeSlots: number[] = [];
    // Slots whose session has already had its one-time handlers attached. Persists
    // for the process lifetime because fromPartition sessions are never destroyed.
    private sessionInitializedSlots: Set<number> = new Set();

    private constructor(config: Partial<WindowPoolConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG };
        this.applyConfig(config);
    }

    private applyConfig(config: Partial<WindowPoolConfig>): void {
        const poolSize = sanitizePositiveInt(config.poolSize);
        const maxConcurrency = sanitizePositiveInt(config.maxConcurrency);
        this.config = {
            ...this.config,
            ...config,
            ...(poolSize !== undefined ? { poolSize } : {}),
            ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
        };
    }

    // WindowPool is a process-wide singleton. A config override is applied as
    // long as the pool hasn't actually spun up windows yet (this.initialized),
    // regardless of when the singleton object itself was first constructed -
    // otherwise a maxWindows override on the first real job is silently
    // dropped if anything (e.g. a connect-time call with no config) created
    // the instance earlier. Once windows/sessions are live, a differing
    // override is logged and ignored rather than resizing a pool in use.
    public static getInstance(config?: Partial<WindowPoolConfig>): WindowPool {
        if (!WindowPool.instance) {
            WindowPool.instance = new WindowPool(config);
            return WindowPool.instance;
        }
        const hasOverride = config?.poolSize !== undefined || config?.maxConcurrency !== undefined;
        if (hasOverride) {
            if (!WindowPool.instance.initialized) {
                WindowPool.instance.applyConfig(config!);
            } else {
                const { poolSize, maxConcurrency } = WindowPool.instance.config;
                if (config!.poolSize !== poolSize || config!.maxConcurrency !== maxConcurrency) {
                    Logger.log(
                        `[WindowPool] Already initialized with maxWindows=${maxConcurrency}; ` +
                        `ignoring requested override (poolSize=${config!.poolSize}, maxConcurrency=${config!.maxConcurrency}) for this call.`
                    );
                }
            }
        }
        return WindowPool.instance;
    }

    /**
     * Allow lazy initialization again after a previous shutdown.
     */
    public resume(): void {
        this.shuttingDown = false;
    }

    /**
     * Initialize the window pool.
     *
     * Concurrent callers (e.g. two jobs racing on a cold pool, since both
     * acquireWindow() and executeWithWindow() check `!this.initialized` and
     * then call this) must share one in-flight promise rather than each
     * running the window/slot creation sequence independently - that
     * previously corrupted slot accounting and crashed with "No free session
     * slot available".
     */
    public async initialize(): Promise<void> {
        if (this.shuttingDown) {
            throw new Error('[WindowPool] Cannot initialize while shut down');
        }

        if (this.initialized) {
            Logger.log('[WindowPool] Already initialized');
            return;
        }

        if (this.initializingPromise) {
            return this.initializingPromise;
        }

        this.initializingPromise = this.doInitialize().finally(() => {
            this.initializingPromise = null;
        });
        return this.initializingPromise;
    }

    private async doInitialize(): Promise<void> {
        Logger.log(`[WindowPool] Initializing pool with ${this.config.poolSize} windows, max concurrency: ${this.config.maxConcurrency}`);

        // Set up app-level crash handlers to prevent dialogs
        this.setupCrashHandlers();

        // p-limit is pinned to its last CommonJS release (3.1.0) so it can be a normal
        // static import. This avoids the runtime dynamic import() that breaks inside an
        // Electron asar archive (Electron's ESM loader cannot read ESM from asar).
        this.limit = pLimit(this.config.maxConcurrency);

        // Initialize the fixed set of session slots (one reusable session per slot).
        this.freeSlots = Array.from({ length: this.config.poolSize }, (_, i) => i);

        // Create initial pool of windows
        for (let i = 0; i < this.config.poolSize; i++) {
            await this.createPooledWindow();
        }

        this.initialized = true;
        this.startPeriodicCleanup();

        Logger.log(`[WindowPool] Initialized successfully. Pool size: ${this.pool.length}`);
    }

    /**
     * Set up app-level crash handlers to prevent system dialogs
     */
    private setupCrashHandlers(): void {
        if (this.crashHandlersInitialized) {
            return;
        }
        this.crashHandlersInitialized = true;

        // Handle child process crashes silently
        app.on('child-process-gone', (_event, details) => {
            Logger.log(`[WindowPool] Child process gone: ${details.type} - ${details.reason}`);
            // Don't show any dialog, just log
        });

        // Handle render process crashes at app level (backup for per-window handler)
        app.on('render-process-gone', (_event, _webContents, details) => {
            Logger.log(`[WindowPool] Render process gone (app-level): ${details.reason}`);
            // Window pool will handle cleanup via per-window handler
        });

        // Handle GPU info updates silently
        app.on('gpu-info-update', () => {
            // GPU info updated, no action needed
        });

        Logger.log('[WindowPool] Crash handlers initialized');
    }

    /**
     * Reserve a session slot. Slots index a fixed set of reusable sessions (one
     * per slot), so the number of live sessions never exceeds poolSize.
     */
    private acquireSlot(): number {
        const slot = this.freeSlots.shift();
        if (slot === undefined) {
            // Should be unreachable: live windows are capped at poolSize and every
            // disposal path frees its slot. Guard so accounting bugs fail loudly.
            throw new Error('[WindowPool] No free session slot available (slot accounting invariant violated)');
        }
        return slot;
    }

    /**
     * Return a slot to the free set so its session can be reused by a new window.
     */
    private releaseSlot(slot: number): void {
        if (!this.freeSlots.includes(slot)) {
            this.freeSlots.push(slot);
        }
    }

    /**
     * Attach the one-time, session-level handlers for a pool slot's session.
     * Must run at most once per slot session: setter APIs replace on re-call, but
     * session.on('will-download') would accumulate a listener on every reuse.
     */
    private setupSlotSession(slotSession: Session, slot: number): void {
        // Prevent downloads from being saved to disk
        slotSession.on('will-download', (event) => {
            Logger.log(`[WindowPool] Download blocked in slot ${slot}`);
            event.preventDefault();
        });

        // CRITICAL: Deny all permission requests silently (no dialogs)
        slotSession.setPermissionRequestHandler((_webContents, permission, callback) => {
            Logger.log(`[WindowPool] Permission request denied: ${permission}`);
            callback(false); // Deny all permissions
        });

        // Deny permission checks too (synchronous check)
        slotSession.setPermissionCheckHandler((_webContents, permission, _requestingOrigin) => {
            Logger.log(`[WindowPool] Permission check denied: ${permission}`);
            return false; // Deny all
        });

        // Block device access requests
        slotSession.setDevicePermissionHandler((details) => {
            Logger.log(`[WindowPool] Device access denied: ${details.deviceType}`);
            return false;
        });

        // Block certificate errors silently (no dialogs)
        slotSession.setCertificateVerifyProc((_request, callback) => {
            callback(0); // Accept all certificates to avoid dialogs
        });

        attachClientHeaderHook(slotSession);
    }

    /**
     * Create a new pooled window.
     *
     * Uses a per-slot reusable session (see setupSlotSession) so the number of
     * Electron sessions, and the network contexts that hold OS threads + Mach
     * ports, stays capped at poolSize. Minting a unique session per window was the
     * source of the handle/port leak.
     */
    private async createPooledWindow(): Promise<PooledWindow> {
        if (this.shuttingDown) {
            throw new Error('[WindowPool] Window creation cancelled during shutdown');
        }

        // Reserve a slot synchronously (before any await) so two concurrent
        // creations can never grab the same slot / session.
        const slot = this.acquireSlot();
        const windowId = `window-slot${slot}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

        let createdWindow: BrowserWindow | undefined;
        try {
            // One session per pool slot, reused across window generations.
            const slotSession = session.fromPartition(`mellowtel-pool-slot-${slot}`);

            if (this.sessionInitializedSlots.has(slot)) {
                // Reused session: reset per-generation state so the new window starts
                // like a fresh profile (matches the old unique-session behavior) and
                // per-session cache/cookies stay bounded.
                try {
                    await slotSession.closeAllConnections();
                    await slotSession.clearStorageData();
                    await slotSession.clearCache();
                } catch (err) {
                    Logger.error(`[WindowPool] Error resetting session for slot ${slot}: ${err}`);
                }
            } else {
                // First use of this slot's session: attach session-level handlers once.
                this.setupSlotSession(slotSession, slot);
                this.sessionInitializedSlots.add(slot);
            }

            const uniqueSession = slotSession;

        const win = new BrowserWindow({
            show: false,
            width: 1709,
            height: 984,
            x: -10000,                  // Position off-screen as failsafe
            y: -10000,
            focusable: false,           // Prevent focus stealing
            webPreferences: {
                offscreen: true,
                nodeIntegration: false,
                // Preload must patch the page's window; isolated preload cannot do that.
                contextIsolation: false,
                nodeIntegrationInSubFrames: true,
                preload: getDialogBlockPreloadPath(),
                disableDialogs: true,
                session: uniqueSession,
                webSecurity: true,
                allowRunningInsecureContent: false,
                experimentalFeatures: false,
                enablePreferredSizeMode: false,
                spellcheck: false,      // Disable spellcheck popups
            }
        });
        createdWindow = win;

        // CRITICAL: Prevent beforeunload dialogs
        win.webContents.on('will-prevent-unload', (event) => {
            Logger.log(`[WindowPool] Prevented beforeunload dialog in ${windowId}`);
            event.preventDefault();
        });

        // CRITICAL: Block HTTP authentication dialogs
        win.webContents.on('login', (event, _details, _authInfo, callback) => {
            Logger.log(`[WindowPool] HTTP auth blocked in ${windowId}`);
            event.preventDefault();
            callback('', ''); // Provide empty credentials
        });

        // BLOCK: Print dialog
        (win.webContents as any).on('will-print', (event: any) => {
            Logger.log(`[WindowPool] Print blocked in ${windowId}`);
            event.preventDefault();
        });

        // BLOCK: Client certificate selection dialog
        win.webContents.on('select-client-certificate', (event, _url, _list, callback) => {
            Logger.log(`[WindowPool] Client cert selection blocked in ${windowId}`);
            event.preventDefault();
            callback(undefined as any);
        });

        // BLOCK: Bluetooth device selection
        win.webContents.on('select-bluetooth-device', (event, _devices, callback) => {
            Logger.log(`[WindowPool] Bluetooth selection blocked in ${windowId}`);
            event.preventDefault();
            callback('');
        });

        // BLOCK: Serial port selection
        (win.webContents as any).on('select-serial-port', (event: any, _ports: any, _webContents: any, callback: any) => {
            Logger.log(`[WindowPool] Serial port selection blocked in ${windowId}`);
            event.preventDefault();
            callback('');
        });

        // BLOCK: HID device selection
        (win.webContents as any).on('select-hid-device', (event: any, _details: any, callback: any) => {
            Logger.log(`[WindowPool] HID device selection blocked in ${windowId}`);
            event.preventDefault();
            callback(undefined);
        });

        // BLOCK: USB device selection
        (win.webContents as any).on('select-usb-device', (event: any, _details: any, callback: any) => {
            Logger.log(`[WindowPool] USB device selection blocked in ${windowId}`);
            event.preventDefault();
            callback(undefined);
        });

        // BLOCK: External protocol navigations that could open system apps
        const BLOCKED_PROTOCOLS = [
            'mailto:', 'tel:', 'sms:', 'callto:',
            'ms-windows-store:', 'ms-settings:',
            'slack:', 'spotify:', 'steam:', 'discord:',
            'zoommtg:', 'msteams:', 'skype:',
            'file:', 'ftp:', 'sftp:',
        ];

        win.webContents.on('will-navigate', (event, url) => {
            const urlLower = url.toLowerCase();
            for (const protocol of BLOCKED_PROTOCOLS) {
                if (urlLower.startsWith(protocol)) {
                    Logger.log(`[WindowPool] Blocked navigation to ${protocol} in ${windowId}`);
                    event.preventDefault();
                    return;
                }
            }
        });

        // Also block external protocols in new-window attempts
        win.webContents.setWindowOpenHandler(({ url }) => {
            const urlLower = url.toLowerCase();
            for (const protocol of BLOCKED_PROTOCOLS) {
                if (urlLower.startsWith(protocol)) {
                    Logger.log(`[WindowPool] Blocked popup to ${protocol} in ${windowId}`);
                    return { action: 'deny' };
                }
            }
            Logger.log(`[WindowPool] Popup blocked in ${windowId}`);
            return { action: 'deny' }; // Block all popups anyway
        });

        // Dialog/UI blocking is handled by src/preload/dialog-block.ts (see webPreferences.preload).

        // Ensure window is always muted and can never play sound
        win.webContents.setAudioMuted(true);

        // CRITICAL: Prevent window from ever becoming visible
        win.on('show', () => {
            Logger.log(`[WindowPool] Window ${windowId} attempted to show, hiding it`);
            win.setPosition(-10000, -10000); // Move off-screen immediately
            win.hide();
        });

        // Block focus attempts that could make window visible
        win.on('focus', () => {
            Logger.log(`[WindowPool] Window ${windowId} attempted to focus, hiding it`);
            win.blur();
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

        win.webContents.setUserAgent(getDeviceClient().userAgent || '');

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
            session: uniqueSession,
            slot,
            id: windowId,
            inUse: false,
            createdAt: Date.now(),
            usageCount: 0,
            lastUsedAt: Date.now(),
            needsRotation: false
        };

        if (this.shuttingDown) {
            throw new Error('[WindowPool] Window creation cancelled during shutdown');
        }

        this.pool.push(pooledWindow);
        Logger.log(`[WindowPool] Created window ${windowId} on slot ${slot}. Pool size: ${this.pool.length}`);

        return pooledWindow;
        } catch (error) {
            // Creation failed after reserving the slot: destroy any half-created
            // window and return the slot so capacity is not permanently lost.
            if (createdWindow && !createdWindow.isDestroyed()) {
                createdWindow.destroy();
            }
            this.releaseSlot(slot);
            throw error;
        }
    }

    /**
     * Acquire a window from the pool with timeout
     */
    private async acquireWindow(startTime: number = Date.now()): Promise<PooledWindow> {
        if (this.shuttingDown) {
            throw new Error('[WindowPool] Cannot acquire a window while shut down');
        }

        if (!this.initialized) {
            await this.initialize();
        }

        // Check if we've exceeded the 50-second timeout
        const elapsedTime = Date.now() - startTime;
        if (elapsedTime > 50000) {
            const error = new ObservedError('[WindowPool] Timeout: No window became available within 50 seconds', {
                code: 'WINDOW_ACQUIRE_TIMEOUT',
                stage: 'window_pool',
                raw: { timeout_ms: 50000, elapsed_ms: elapsedTime },
            });
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
        if (this.shuttingDown) {
            if (!pooledWindow.window.isDestroyed()) {
                pooledWindow.window.destroy();
            }
            this.removeWindowFromPool(pooledWindow.id);
            return;
        }

        if (pooledWindow.window.isDestroyed()) {
            Logger.log(`[WindowPool] Window ${pooledWindow.id} was destroyed, removing from pool`);
            this.removeWindowFromPool(pooledWindow.id);
            // Create a replacement window to maintain pool size
            if (!this.shuttingDown && this.pool.length < this.config.poolSize && !this.creatingWindow) {
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
        if (this.shuttingDown) {
            throw new Error('[WindowPool] Cannot accept work while shut down');
        }

        // Ensure pool is initialized before using this.limit
        if (!this.initialized) {
            await this.initialize();
        }

        return this.limit(async () => {
            const pooledWindow = await this.acquireWindow();
            const startTime = Date.now();

            // Watchdog timer to detect stuck windows (>60 seconds)
            const watchdogTimer = setInterval(() => {
                const elapsedTime = Date.now() - startTime;
                if (elapsedTime > 60000 && pooledWindow.inUse) {
                    Logger.error(`[WindowPool] Window ${pooledWindow.id} stuck for ${Math.floor(elapsedTime / 1000)}s, destroying it`);
                    clearInterval(watchdogTimer);
                    
                    // Destroy the stuck window
                    if (!pooledWindow.window.isDestroyed()) {
                        pooledWindow.window.destroy();
                    }
                    this.removeWindowFromPool(pooledWindow.id);
                    
                    // Create replacement window to maintain pool size
                    if (!this.shuttingDown && this.pool.length < this.config.poolSize && !this.creatingWindow) {
                        this.creatingWindow = true;
                        this.createPooledWindow().finally(() => {
                            this.creatingWindow = false;
                        });
                    }
                }
            }, 5000); // Check every 5 seconds

            try {
                // Double-check window is not destroyed before executing task
                if (pooledWindow.window.isDestroyed()) {
                    throw new Error(`[WindowPool] Window ${pooledWindow.id} was destroyed before task execution`);
                }

                const result = await task(pooledWindow.window);
                clearInterval(watchdogTimer);
                return result;
            } catch (error) {
                clearInterval(watchdogTimer);
                
                // On ANY error, destroy the window and replace it
                Logger.error(`[WindowPool] Error in window ${pooledWindow.id}, destroying and replacing: ${error}`);
                
                // Destroy the problematic window
                if (!pooledWindow.window.isDestroyed()) {
                    pooledWindow.window.destroy();
                }
                this.removeWindowFromPool(pooledWindow.id);
                
                // Create replacement window to maintain pool size
                if (!this.shuttingDown && this.pool.length < this.config.poolSize && !this.creatingWindow) {
                    this.creatingWindow = true;
                    this.createPooledWindow().finally(() => {
                        this.creatingWindow = false;
                    });
                }
                
                throw error;
            } finally {
                clearInterval(watchdogTimer);
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
        if (this.shuttingDown) {
            return;
        }

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

        // Remove from pool and free its slot so the replacement can reuse the
        // slot's session (reset on reuse inside createPooledWindow).
        this.pool.splice(index, 1);
        this.releaseSlot(pooledWindow.slot);

        // Create new window
        if (!this.shuttingDown) {
            await this.createPooledWindow();
        }

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
            // Free the slot so its session can be reused by a future window.
            this.releaseSlot(pooledWindow.slot);
            Logger.log(`[WindowPool] Removed window ${windowId} (slot ${pooledWindow.slot}). Pool size: ${this.pool.length}`);
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

            // Drop cookies/storage/cache so the next empty job cannot inherit this one.
            if (!window.isDestroyed()) {
                const slotSession = window.webContents.session;
                try {
                    await slotSession.clearStorageData();
                    await slotSession.clearCache();
                } catch (err) {
                    Logger.error(`[WindowPool] Error clearing slot session: ${err}`);
                }
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
            if (this.shuttingDown) {
                return;
            }

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
            while (!this.shuttingDown && this.pool.length < this.config.poolSize && !this.creatingWindow) {
                this.creatingWindow = true;
                try {
                    // Double-check after acquiring lock
                    if (!this.shuttingDown && this.pool.length < this.config.poolSize) {
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
        this.shuttingDown = true;
        this.initialized = false;

        // Stop periodic cleanup
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        // Destroy all windows and release their network resources
        for (const pooledWindow of this.pool) {
            if (!pooledWindow.window.isDestroyed()) {
                pooledWindow.window.destroy();
            }
            pooledWindow.session.closeAllConnections().catch(() => { /* best effort */ });
        }

        this.pool = [];
        // Reset slot availability so a later initialize() can allocate again.
        // sessionInitializedSlots is intentionally NOT reset: fromPartition sessions
        // are cached for the process lifetime and keep their one-time handlers, so
        // re-attaching would leak listeners.
        this.freeSlots = [];
        Logger.log('[WindowPool] Shutdown complete');
    }
}

// Export singleton getter
export const getWindowPool = (config?: Partial<WindowPoolConfig>) => WindowPool.getInstance(config);

/**
 * Builds the {poolSize, maxConcurrency} override for getWindowPool() from a
 * request's maxWindows field, or undefined when it's absent/invalid - callers
 * don't need to validate it themselves. See DataRequest.maxWindows and
 * WindowPool.getInstance for how a value from a later request is handled once
 * the pool already exists.
 */
export function windowPoolConfigFor(dataRequest: { maxWindows?: number }): Partial<WindowPoolConfig> | undefined {
    const maxWindows = sanitizePositiveInt(dataRequest.maxWindows);
    return maxWindows !== undefined ? { poolSize: maxWindows, maxConcurrency: maxWindows } : undefined;
}
