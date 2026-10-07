import * as electron from 'electron';
import { app, BrowserWindow } from 'electron';
import { Logger } from '../logger/logger';

/**
 * Ties Mellowtel's lifetime to the host app's main process, without the host
 * having to call shutdown().
 *
 * The SDK's hidden worker windows count as open windows to Electron, so while
 * they exist the host's `window-all-closed` never fires and a normal app keeps
 * running in the background after the user closes its last window. To avoid
 * that, the SDK releases its worker windows as soon as the host has no windows
 * left. Electron then behaves as if Mellowtel weren't there:
 *  - a normal app quits, and `will-quit` shuts Mellowtel down completely;
 *  - a tray/background app keeps running, and Mellowtel recreates its worker
 *    windows on the next job.
 *
 * Never listen to `window-all-closed` here: registering any listener disables
 * Electron's default auto-quit for hosts that don't handle it themselves.
 */

interface LifecycleHandlers {
    /** The host has no windows left. Release worker windows, keep the connection. */
    onLastHostWindowClosed: () => void;
    /** The main process is quitting. Shut down completely. */
    onAppQuit: () => void;
}

// Window ids, not objects: BaseWindow.getAllWindows() may hand back different
// wrappers, and a destroyed window throws when its id is read.
const sdkWindowIds = new Set<number>();
let installed = false;

/**
 * Marks a window as owned by the SDK so it is never counted as a host window.
 * Call right after creating every worker window.
 */
export function markSdkWindow<T extends BrowserWindow>(win: T): T {
    const id = win.id;
    sdkWindowIds.add(id);
    win.once('closed', () => sdkWindowIds.delete(id));
    return win;
}

function hostWindowCount(): number {
    // BaseWindow (Electron 30+) also covers hosts built on BaseWindow + WebContentsView.
    const baseWindow = (electron as any).BaseWindow;
    const all: Array<{ id: number; isDestroyed(): boolean }> =
        typeof baseWindow?.getAllWindows === 'function' ? baseWindow.getAllWindows() : BrowserWindow.getAllWindows();
    return all.filter((w) => !w.isDestroyed() && !sdkWindowIds.has(w.id)).length;
}

/**
 * Installs the app-level listeners once per process. Safe to call repeatedly.
 */
export function installAppLifecycle(handlers: LifecycleHandlers): void {
    if (installed) return;
    installed = true;

    const watch = (win: BrowserWindow) => {
        const id = win.id;
        win.once('closed', () => {
            // SDK windows are marked after creation, so decide at close time.
            if (sdkWindowIds.has(id)) return;
            if (hostWindowCount() === 0) {
                Logger.log('[Lifecycle] Last host window closed, releasing worker windows');
                handlers.onLastHostWindowClosed();
            }
        });
    };

    BrowserWindow.getAllWindows().forEach(watch);
    app.on('browser-window-created', (_event, win) => watch(win));

    // will-quit only fires once the quit is committed: a host that cancels the
    // quit in before-quit (e.g. minimize to tray) keeps Mellowtel running.
    app.once('will-quit', () => {
        Logger.log('[Lifecycle] App is quitting, shutting down');
        handlers.onAppQuit();
    });
}
