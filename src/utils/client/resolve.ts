import { BrowserWindow, Session } from "electron";
import { getCurrentClientDefaults } from "./defaults";
import { getDeviceClient } from "./device";
import {
    ClientConfig,
    ClientPlugin,
    ClientScreen,
    ClientWebgl,
    DEFAULT_PLUGINS,
    ResolvedClient,
} from "./types";

const sessionClients = new WeakMap<Session, ResolvedClient>();
let cachedDefault: ResolvedClient | undefined;

function defined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

/** Case-insensitive lookup into a job's raw `headers` overlay. Used so that a
 *  job setting e.g. `headers["Accept-Language"]` directly (instead of the
 *  structured `acceptLanguage`/`userAgent` fields) still counts as a job key
 *  and isn't silently clobbered by the forced header/navigator sync below -
 *  see applyClientHeaders' forced "User-Agent"/"accept-language" keys. */
function findHeaderValue(headers: Record<string, string> | undefined, name: string): string | undefined {
    if (!headers) {
        return undefined;
    }
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === lower) {
            return headers[key];
        }
    }
    return undefined;
}

function resolveWebgl(overlay: ClientConfig["webgl"], fallback: ClientWebgl): ClientWebgl | false {
    if (overlay === false) {
        return false;
    }
    if (overlay && typeof overlay === "object") {
        return {
            vendor: overlay.vendor ?? fallback.vendor,
            renderer: overlay.renderer ?? fallback.renderer,
        };
    }
    return fallback;
}

function resolvePlugins(overlay: ClientConfig["plugins"], fallback: ClientPlugin[]): false | ClientPlugin[] {
    if (overlay === false) {
        return false;
    }
    if (Array.isArray(overlay)) {
        return overlay;
    }
    if (overlay === true) {
        return DEFAULT_PLUGINS;
    }
    return fallback;
}

function resolveScreen(overlay: ClientConfig["screen"], fallback: ClientScreen): ClientScreen {
    return {
        colorDepth: overlay?.colorDepth ?? fallback.colorDepth,
        pixelDepth: overlay?.pixelDepth ?? fallback.pixelDepth,
        availTop: overlay?.availTop ?? fallback.availTop,
        availLeft: overlay?.availLeft ?? fallback.availLeft,
    };
}

export function resolveClient(overlay: ClientConfig = {}): ResolvedClient {
    const current = getCurrentClientDefaults();
    const device = getDeviceClient();
    const fallbackWebgl = current.webgl as ClientWebgl;
    const fallbackScreen = current.screen as ClientScreen;
    const fallbackPlugins = Array.isArray(current.plugins) ? current.plugins : DEFAULT_PLUGINS;

    const headers = {
        ...(current.headers || {}),
        ...(device.headers || {}),
        ...(overlay.headers || {}),
    };

    const acceptLanguage =
        overlay.acceptLanguage ??
        findHeaderValue(overlay.headers, "accept-language") ??
        device.acceptLanguage ??
        "en-US,en;q=0.9";
    headers["accept-language"] = acceptLanguage;

    const userAgent =
        overlay.userAgent ??
        findHeaderValue(overlay.headers, "user-agent") ??
        device.userAgent ??
        "";

    return {
        userAgent,
        acceptLanguage,
        referrer: defined(overlay.referrer) ? overlay.referrer : current.referrer ?? false,
        languages: overlay.languages ?? device.languages ?? ["en-US", "en"],
        headers,
        hardwareConcurrency: overlay.hardwareConcurrency ?? device.hardwareConcurrency ?? 8,
        deviceMemory: overlay.deviceMemory ?? device.deviceMemory ?? 8,
        webgl: resolveWebgl(overlay.webgl, fallbackWebgl),
        screen: resolveScreen(overlay.screen, fallbackScreen),
        connectionRtt: defined(overlay.connectionRtt) ? overlay.connectionRtt : current.connectionRtt ?? false,
        hideWebdriver: overlay.hideWebdriver ?? current.hideWebdriver ?? true,
        chromeObject: overlay.chromeObject ?? current.chromeObject ?? true,
        plugins: resolvePlugins(overlay.plugins, fallbackPlugins),
        outerInset: overlay.outerInset ?? current.outerInset ?? 85,
        pointerNoise: overlay.pointerNoise ?? current.pointerNoise ?? true,
        timerJitter: overlay.timerJitter ?? current.timerJitter ?? true,
    };
}

export function defaultResolvedClient(): ResolvedClient {
    if (!cachedDefault) {
        cachedDefault = resolveClient();
    }
    return cachedDefault;
}

export function setSessionClient(session: Session, client: ResolvedClient): void {
    sessionClients.set(session, client);
}

export function clearSessionClient(session: Session): void {
    sessionClients.delete(session);
}

export function getSessionClient(session: Session): ResolvedClient {
    return sessionClients.get(session) ?? defaultResolvedClient();
}

export function applyClientHeaders(
    existing: Record<string, string>,
    client: ResolvedClient
): Record<string, string> {
    const headers: Record<string, string> = {
        ...existing,
        ...client.headers,
        "User-Agent": client.userAgent,
        "accept-language": client.acceptLanguage,
    };

    if (client.referrer === false) {
        delete headers.Referer;
        delete headers.referer;
    } else if (client.referrer) {
        headers.Referer = client.referrer;
    }

    return headers;
}

export function applyJobClient(win: BrowserWindow, overlay: ClientConfig = {}): ResolvedClient {
    const client = resolveClient(overlay);
    setSessionClient(win.webContents.session, client);
    win.webContents.setUserAgent(client.userAgent);
    return client;
}

export function releaseJobClient(win: BrowserWindow): void {
    if (!win.isDestroyed()) {
        clearSessionClient(win.webContents.session);
    }
}

export function attachClientHeaderHook(session: Session): void {
    session.webRequest.onBeforeSendHeaders((details, callback) => {
        callback({
            requestHeaders: applyClientHeaders(details.requestHeaders, getSessionClient(session)),
        });
    });
}
