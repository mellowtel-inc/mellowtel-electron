import { Logger } from "../../logger/logger";
import { VERSION } from "../../constants";

/** Upper bound on a single callback request. */
const CALLBACK_TIMEOUT_MS = 10 * 1000;

/** Fields shared by every maintenance event sent from the server. */
export interface MaintenanceEvent {
    requestId: string;
    callbackEndpoint: string;
}

/**
 * Callback endpoints must be absolute HTTPS URLs. Anything else is rejected
 * so a maintenance response is never sent over an unencrypted connection.
 */
export function isValidCallbackEndpoint(value: unknown): value is string {
    if (typeof value !== "string" || !value.trim()) {
        return false;
    }
    try {
        return new URL(value.trim()).protocol === "https:";
    } catch {
        return false;
    }
}

/**
 * Reads `request_id` and `callback_endpoint` from a maintenance event.
 * Returns null when the callback endpoint is missing or not HTTPS, in which
 * case the event is ignored entirely.
 */
export function parseMaintenanceEvent(payload: { [key: string]: unknown }): MaintenanceEvent | null {
    if (!isValidCallbackEndpoint(payload.callback_endpoint)) {
        return null;
    }
    return {
        requestId: typeof payload.request_id === "string" ? payload.request_id : "",
        callbackEndpoint: payload.callback_endpoint.trim(),
    };
}

/**
 * POSTs a JSON body to a maintenance callback endpoint. Best effort: every
 * failure is logged and swallowed so it can never affect the host app.
 * Returns true when the endpoint answered with a 2xx status.
 */
export async function postToCallback(endpoint: string, body: unknown): Promise<boolean> {
    if (!isValidCallbackEndpoint(endpoint)) {
        Logger.log("[Maintenance] Callback skipped: endpoint must be an HTTPS URL");
        return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Mellowtel-Version": VERSION,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            Logger.error(`[Maintenance] Callback HTTP ${response.status}`);
            return false;
        }
        return true;
    } catch (error) {
        Logger.error(`[Maintenance] Callback request failed: ${error}`);
        return false;
    } finally {
        clearTimeout(timeout);
    }
}
