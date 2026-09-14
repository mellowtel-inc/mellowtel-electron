import { session, Session, Cookie, CookiesSetDetails } from "electron";
import { Logger } from "../../logger/logger";
import { attachClientHeaderHook } from "../client";

export const JAR_PARTITION = "persist:mellowtel-jar";

const ORIGIN_STORAGES: Array<
    "cookies" | "localstorage" | "indexdb" | "cachestorage" | "serviceworkers"
> = ["cookies", "localstorage", "indexdb", "cachestorage", "serviceworkers"];

let jarSession: Session | undefined;
let sessionHandlersAttached = false;

const persistTail: { current: Promise<unknown> } = { current: Promise.resolve() };
const originTails = new Map<string, Promise<unknown>>();

function enqueue<T>(tail: { current: Promise<unknown> }, fn: () => Promise<T>): Promise<T> {
    const run = tail.current.then(fn, fn);
    tail.current = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

export function withPersistLock<T>(fn: () => Promise<T>): Promise<T> {
    return enqueue(persistTail, fn);
}

export function withOriginLock<T>(origin: string, fn: () => Promise<T>): Promise<T> {
    let tail = originTails.get(origin);
    if (!tail) {
        tail = Promise.resolve();
    }
    const holder = { current: tail };
    const run = enqueue(holder, fn);
    originTails.set(origin, holder.current);

    // Drop this origin's queue entry once it fully drains, as long as nothing
    // newer was enqueued for it in the meantime (in which case originTails.get
    // now points at that newer tail, not this one). Without this, originTails
    // grows by one entry per distinct origin ever seen for the life of the
    // process, even though a settled entry has nothing left to serialize against.
    holder.current.then(() => {
        if (originTails.get(origin) === holder.current) {
            originTails.delete(origin);
        }
    });

    return run;
}

function setupJarSession(ses: Session): void {
    ses.on("will-download", (event) => {
        Logger.log("[Jar] Download blocked");
        event.preventDefault();
    });

    ses.setPermissionRequestHandler((_webContents, permission, callback) => {
        Logger.log(`[Jar] Permission request denied: ${permission}`);
        callback(false);
    });

    ses.setPermissionCheckHandler((_webContents, permission, _requestingOrigin) => {
        Logger.log(`[Jar] Permission check denied: ${permission}`);
        return false;
    });

    ses.setDevicePermissionHandler((details) => {
        Logger.log(`[Jar] Device access denied: ${details.deviceType}`);
        return false;
    });

    ses.setCertificateVerifyProc((_request, callback) => {
        callback(0);
    });

    attachClientHeaderHook(ses);
}

export function getJarSession(): Session {
    if (!jarSession) {
        jarSession = session.fromPartition(JAR_PARTITION);
        if (!sessionHandlersAttached) {
            setupJarSession(jarSession);
            sessionHandlersAttached = true;
        }
    }
    return jarSession;
}

/** True if the jar partition session has already been created. Lets callers
 *  (e.g. shutdown) avoid lazily spinning up the persistent session just to
 *  immediately tear it down when the jar was never actually used. */
export function hasJarSession(): boolean {
    return jarSession !== undefined;
}

function hostnameFromOrigin(origin: string): string {
    return new URL(origin).hostname.toLowerCase();
}

/**
 * `strict` = true requires the cookie's domain to exactly equal `hostname`: it
 * is owned by this origin's host, not merely visible to it. `strict` = false
 * (default) also matches cookies scoped to an ancestor domain (Domain=.example.com
 * is sent to shop.example.com too), matching how Chromium actually attaches
 * cookies to a request.
 *
 * Non-strict matching is fine for snapshot/restore (see restoreCookies): both
 * the pre-visit snapshot and the post-visit cleanup use the same broad match,
 * so an inherited cookie that this visit didn't touch gets removed then
 * re-added unchanged. It is NOT fine for a destructive, no-restore delete like
 * resetJarOrigin's leftover sweep: that would permanently delete a cookie that
 * may be owned by a different (parent/sibling) origin, breaking the jar's
 * per-origin isolation guarantee. Callers that only delete must pass strict.
 */
function cookieMatchesHost(cookie: Cookie, hostname: string, strict = false): boolean {
    const domain = (cookie.domain || "").replace(/^\./, "").toLowerCase();
    if (!domain) {
        return false;
    }
    if (strict) {
        return hostname === domain;
    }
    return hostname === domain || hostname.endsWith(`.${domain}`);
}

function cookieUrl(cookie: Cookie, fallbackOrigin: string): string {
    const host = (cookie.domain || "").replace(/^\./, "") || new URL(fallbackOrigin).hostname;
    const scheme = cookie.secure || fallbackOrigin.startsWith("https:") ? "https" : "http";
    const path = cookie.path && cookie.path.startsWith("/") ? cookie.path : "/";
    return `${scheme}://${host}${path}`;
}

export async function snapshotCookies(origin: string): Promise<Cookie[]> {
    const ses = getJarSession();
    try {
        return await ses.cookies.get({ url: `${origin}/` });
    } catch (error) {
        Logger.error(`[Jar] Failed to snapshot cookies for ${origin}: ${error}`);
        throw error;
    }
}

async function cookiesForOrigin(origin: string, strict = false): Promise<Cookie[]> {
    const ses = getJarSession();
    const hostname = hostnameFromOrigin(origin);
    const all = await ses.cookies.get({});
    return all.filter((cookie) => cookieMatchesHost(cookie, hostname, strict));
}

async function removeCookie(cookie: Cookie, origin: string): Promise<void> {
    const ses = getJarSession();
    await ses.cookies.remove(cookieUrl(cookie, origin), cookie.name);
}

async function setCookie(cookie: Cookie, origin: string): Promise<void> {
    const ses = getJarSession();
    const details: CookiesSetDetails = {
        url: cookieUrl(cookie, origin),
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.expirationDate,
        sameSite: cookie.sameSite,
    };
    if (!cookie.hostOnly && cookie.domain) {
        details.domain = cookie.domain;
    }
    await ses.cookies.set(details);
}

export async function restoreCookies(origin: string, snapshot: Cookie[]): Promise<void> {
    const current = await cookiesForOrigin(origin);
    for (const cookie of current) {
        try {
            await removeCookie(cookie, origin);
        } catch (error) {
            Logger.error(`[Jar] Failed to remove cookie ${cookie.name} for ${origin}: ${error}`);
        }
    }
    for (const cookie of snapshot) {
        try {
            await setCookie(cookie, origin);
        } catch (error) {
            Logger.error(`[Jar] Failed to restore cookie ${cookie.name} for ${origin}: ${error}`);
        }
    }
    Logger.log(`[Jar] Restored ${snapshot.length} cookie(s) for ${origin}`);
}

export async function resetJarOrigin(origin: string): Promise<void> {
    return withPersistLock(() =>
        withOriginLock(origin, async () => {
            const ses = getJarSession();
            try {
                await ses.clearStorageData({
                    origin,
                    storages: ORIGIN_STORAGES,
                });
            } catch (error) {
                Logger.error(`[Jar] clearStorageData failed for ${origin}: ${error}`);
                throw error;
            }

            // Strict: this is a one-way delete with no restore step, so it must
            // never remove a cookie that clearStorageData left behind but that is
            // actually owned by a different (e.g. parent-domain) origin.
            const leftovers = await cookiesForOrigin(origin, true);
            for (const cookie of leftovers) {
                try {
                    await removeCookie(cookie, origin);
                } catch (error) {
                    Logger.error(`[Jar] Failed to remove leftover cookie ${cookie.name} for ${origin}: ${error}`);
                }
            }
            Logger.log(`[Jar] Reset origin ${origin}`);
        })
    );
}

export async function resetJarAll(): Promise<void> {
    return withPersistLock(async () => {
        const ses = getJarSession();
        try {
            await ses.clearStorageData();
            await ses.clearCache();
            Logger.log("[Jar] Reset all stored origin data");
        } catch (error) {
            Logger.error(`[Jar] Failed to reset all: ${error}`);
            throw error;
        }
    });
}

export async function handleJarEvent(payload: { [key: string]: unknown }): Promise<void> {
    if (payload.action !== "reset") {
        Logger.log(`[Jar] Ignored jar event: unknown action ${String(payload.action)}`);
        return;
    }

    if (payload.scope === "all") {
        try {
            await resetJarAll();
        } catch (error) {
            Logger.error(`[Jar] Standalone reset-all failed: ${error}`);
        }
        return;
    }

    if (payload.scope === "origin") {
        if (typeof payload.origin !== "string" || !payload.origin) {
            Logger.log("[Jar] Ignored jar reset: missing origin");
            return;
        }
        try {
            const origin = new URL(payload.origin).origin;
            await resetJarOrigin(origin);
        } catch (error) {
            Logger.error(`[Jar] Standalone reset-origin failed: ${error}`);
        }
        return;
    }

    Logger.log(`[Jar] Ignored jar event: invalid scope ${String(payload.scope)}`);
}
