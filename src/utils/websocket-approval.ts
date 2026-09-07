import { app } from "electron";
import {
  APPROVAL_API_URL,
  APPROVAL_CHECK_INTERVAL,
  APPROVAL_RETRY_DELAYS,
} from "../constants";
import { Logger } from "../logger/logger";
import { getLocalStorage, setLocalStorage } from "../storage/storage-helpers";

const APPROVAL_CACHE_KEY = "websocket_approval_cache";

interface ApprovalCacheData {
  timestamp: number;
  isApproved: boolean;
}

export interface WebsocketApprovalParams {
  device_id: string;
  plugin_id: string;
  version: string;
  speed_download: number;
  platform: string;
  manifest_version: string;
}

export function getElectronPluginId(): string {
  try {
    return app.getName() || "mellowtel-electron";
  } catch {
    return "mellowtel-electron";
  }
}

function readApprovalCache(): ApprovalCacheData | null {
  const cachedData = getLocalStorage(APPROVAL_CACHE_KEY);
  if (!cachedData) {
    return null;
  }

  try {
    const data: ApprovalCacheData =
      typeof cachedData === "string" ? JSON.parse(cachedData) : cachedData;
    if (
      typeof data?.timestamp !== "number" ||
      typeof data?.isApproved !== "boolean"
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }

    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function getApprovalRecheckDelayMs(): number {
  const cachedData = readApprovalCache();
  if (!cachedData) {
    return APPROVAL_CHECK_INTERVAL;
  }
  return Math.max(
    0,
    APPROVAL_CHECK_INTERVAL - (Date.now() - cachedData.timestamp),
  );
}

export async function checkWebsocketApproval(
  params: WebsocketApprovalParams,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }

  const cachedData = readApprovalCache();
  const now = Date.now();

  if (cachedData && now - cachedData.timestamp < APPROVAL_CHECK_INTERVAL) {
    Logger.log(
      `[WebSocketManager]: Using cached websocket approval result. Minutes until expiration: ${
        (APPROVAL_CHECK_INTERVAL - (now - cachedData.timestamp)) / 60000
      }`,
    );
    return cachedData.isApproved;
  }

  const queryParams = new URLSearchParams({
    device_id: params.device_id,
    plugin_id: params.plugin_id,
    version: params.version,
    speed_download: params.speed_download.toString(),
    platform: params.platform,
    manifest_version: params.manifest_version,
    ws_client: "new_ws",
  });

  return retryApprovalRequest(
    `${APPROVAL_API_URL}?${queryParams.toString()}`,
    0,
    signal,
  );
}

async function retryApprovalRequest(
  url: string,
  retryAttempt: number = 0,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }

  try {
    const response = await fetch(url, { signal });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        `Approval request failed with status code ${response.status}`,
      );
    }

    Logger.log(
      `[WebSocketManager]: Approval result: ${JSON.stringify(result)}`,
    );

    const cacheData: ApprovalCacheData = {
      timestamp: Date.now(),
      isApproved: result.approval === true,
    };
    setLocalStorage(APPROVAL_CACHE_KEY, cacheData);

    return result.approval === true;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      Logger.log("[WebSocketManager]: Approval request aborted");
      return false;
    }

    const delayMs =
      retryAttempt < APPROVAL_RETRY_DELAYS.length
        ? APPROVAL_RETRY_DELAYS[retryAttempt]
        : APPROVAL_RETRY_DELAYS[APPROVAL_RETRY_DELAYS.length - 1];

    Logger.log(
      `[WebSocketManager]: Approval request failed (attempt ${retryAttempt + 1}). Retrying in ${delayMs / 1000} seconds.`,
      error,
    );

    try {
      await delay(delayMs, signal);
    } catch (delayError) {
      if (signal?.aborted || isAbortError(delayError)) {
        Logger.log("[WebSocketManager]: Approval request aborted");
        return false;
      }
      throw delayError;
    }
    return retryApprovalRequest(url, retryAttempt + 1, signal);
  }
}
