import { BrowserWindow } from "electron";
import { Logger } from "../../logger/logger";
import { DEFAULT_WINDOW_DISPLAY, getDialogBlockPreloadPath, isDefaultWindowDisplay, WindowDisplay } from "../window-pool";
import { getDeviceClient } from "../client";
import { getJarSession, hasJarSession, withOriginLock, withPersistLock } from "./store";

const BLOCKED_PROTOCOLS = [
    "mailto:",
    "tel:",
    "sms:",
    "callto:",
    "ms-windows-store:",
    "ms-settings:",
    "slack:",
    "spotify:",
    "steam:",
    "discord:",
    "zoommtg:",
    "msteams:",
    "skype:",
    "file:",
    "ftp:",
    "sftp:",
];

let jarWindow: BrowserWindow | undefined;
let visibilityCheck: NodeJS.Timeout | null = null;
let shuttingDown = false;

export function resumeJarWindow(): void {
    shuttingDown = false;
}

function attachHardening(win: BrowserWindow, display: WindowDisplay = DEFAULT_WINDOW_DISPLAY): void {
    win.webContents.on("will-prevent-unload", (event) => {
        Logger.log("[Jar] Prevented beforeunload dialog");
        event.preventDefault();
    });

    win.webContents.on("login", (event, _details, _authInfo, callback) => {
        Logger.log("[Jar] HTTP auth blocked");
        event.preventDefault();
        callback("", "");
    });

    (win.webContents as any).on("will-print", (event: any) => {
        Logger.log("[Jar] Print blocked");
        event.preventDefault();
    });

    win.webContents.on("select-client-certificate", (event, _url, _list, callback) => {
        Logger.log("[Jar] Client cert selection blocked");
        event.preventDefault();
        callback(undefined as any);
    });

    win.webContents.on("select-bluetooth-device", (event, _devices, callback) => {
        Logger.log("[Jar] Bluetooth selection blocked");
        event.preventDefault();
        callback("");
    });

    (win.webContents as any).on("select-serial-port", (event: any, _ports: any, _webContents: any, callback: any) => {
        Logger.log("[Jar] Serial port selection blocked");
        event.preventDefault();
        callback("");
    });

    (win.webContents as any).on("select-hid-device", (event: any, _details: any, callback: any) => {
        Logger.log("[Jar] HID selection blocked");
        event.preventDefault();
        callback(undefined);
    });

    (win.webContents as any).on("select-usb-device", (event: any, _details: any, callback: any) => {
        Logger.log("[Jar] USB selection blocked");
        event.preventDefault();
        callback(undefined);
    });

    win.webContents.on("will-navigate", (event, url) => {
        const urlLower = url.toLowerCase();
        for (const protocol of BLOCKED_PROTOCOLS) {
            if (urlLower.startsWith(protocol)) {
                Logger.log(`[Jar] Blocked navigation to ${protocol}`);
                event.preventDefault();
                return;
            }
        }
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
        const urlLower = url.toLowerCase();
        for (const protocol of BLOCKED_PROTOCOLS) {
            if (urlLower.startsWith(protocol)) {
                Logger.log(`[Jar] Blocked popup to ${protocol}`);
                return { action: "deny" };
            }
        }
        Logger.log("[Jar] Popup blocked");
        return { action: "deny" };
    });

    win.webContents.setAudioMuted(true);

    if (!display.visible) {
        win.on("show", () => {
            Logger.log("[Jar] Window attempted to show, hiding it");
            win.setPosition(-10000, -10000);
            win.hide();
        });

        win.on("focus", () => {
            Logger.log("[Jar] Window attempted to focus, hiding it");
            win.blur();
            win.hide();
        });

        if (visibilityCheck) {
            clearInterval(visibilityCheck);
        }
        visibilityCheck = setInterval(() => {
            if (win && !win.isDestroyed() && win.isVisible()) {
                Logger.log("[Jar] Window became visible, hiding it immediately");
                win.hide();
            }
        }, 100);
    }

    win.on("closed", () => {
        if (visibilityCheck) {
            clearInterval(visibilityCheck);
            visibilityCheck = null;
        }
        if (jarWindow === win) {
            jarWindow = undefined;
        }
    });

    win.webContents.setUserAgent(getDeviceClient().userAgent || "");

    win.webContents.on("render-process-gone", (_event, details) => {
        Logger.error(`[Jar] Render process gone: ${details.reason}`);
        if (!win.isDestroyed()) {
            win.destroy();
        }
        jarWindow = undefined;
    });
}

function createJarWindow(display: WindowDisplay = DEFAULT_WINDOW_DISPLAY): BrowserWindow {
    const win = new BrowserWindow({
        show: display.visible,
        width: 1709,
        height: 984,
        ...(display.visible ? {} : { x: -10000, y: -10000 }),
        focusable: display.visible,
        webPreferences: {
            offscreen: display.offscreen,
            nodeIntegration: false,
            contextIsolation: false,
            nodeIntegrationInSubFrames: true,
            preload: getDialogBlockPreloadPath(),
            disableDialogs: true,
            session: getJarSession(),
            webSecurity: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: false,
            enablePreferredSizeMode: false,
            spellcheck: false,
        },
    });
    attachHardening(win, display);
    Logger.log(`[Jar] Created persist-backed window (visible=${display.visible}, offscreen=${display.offscreen})`);
    return win;
}

function getOrCreateJarWindow(): BrowserWindow {
    if (jarWindow && !jarWindow.isDestroyed()) {
        return jarWindow;
    }
    jarWindow = createJarWindow();
    return jarWindow;
}

async function cleanupJarWindow(win: BrowserWindow): Promise<void> {
    if (win.isDestroyed()) {
        return;
    }
    try {
        await win.loadURL("about:blank");
    } catch (error) {
        if (!win.isDestroyed()) {
            Logger.error(`[Jar] Error loading blank page: ${error}`);
        }
    }
}

export async function executeWithJarWindow<T>(
    origin: string,
    task: (window: BrowserWindow) => Promise<T>,
    display: WindowDisplay = DEFAULT_WINDOW_DISPLAY
): Promise<T> {
    if (shuttingDown) {
        throw new Error("[Jar] Cannot accept work while shut down");
    }

    return withPersistLock(() =>
        withOriginLock(origin, async () => {
            if (shuttingDown) {
                throw new Error("[Jar] Cannot accept work while shut down");
            }

            if (!isDefaultWindowDisplay(display)) {
                if (jarWindow && !jarWindow.isDestroyed()) {
                    jarWindow.destroy();
                }
                jarWindow = undefined;
                const win = createJarWindow(display);
                try {
                    return await task(win);
                } catch (error) {
                    Logger.error(`[Jar] Error in window, destroying it: ${error}`);
                    throw error;
                } finally {
                    if (!win.isDestroyed()) {
                        win.destroy();
                    }
                    jarWindow = undefined;
                }
            }

            const win = getOrCreateJarWindow();
            try {
                if (win.isDestroyed()) {
                    throw new Error("[Jar] Window was destroyed before task execution");
                }
                return await task(win);
            } catch (error) {
                Logger.error(`[Jar] Error in persist window, destroying it: ${error}`);
                if (!win.isDestroyed()) {
                    win.destroy();
                }
                jarWindow = undefined;
                throw error;
            } finally {
                if (jarWindow && !jarWindow.isDestroyed()) {
                    await cleanupJarWindow(jarWindow);
                }
            }
        })
    );
}

export async function shutdownJarWindow(): Promise<void> {
    Logger.log("[Jar] Shutting down persist window");
    shuttingDown = true;
    if (visibilityCheck) {
        clearInterval(visibilityCheck);
        visibilityCheck = null;
    }
    if (jarWindow && !jarWindow.isDestroyed()) {
        jarWindow.destroy();
    }
    jarWindow = undefined;
    // Only close connections on a session that actually exists - calling
    // getJarSession() here would lazily create the persistent jar partition
    // just to immediately tear it down, even if the jar was never used.
    if (hasJarSession()) {
        try {
            await getJarSession().closeAllConnections();
        } catch {
            // best effort
        }
    }
    Logger.log("[Jar] Shutdown complete");
}
