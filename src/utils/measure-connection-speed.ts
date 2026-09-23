import { app, net } from "electron";
import { Logger } from "../logger/logger";
import { getLocalStorage, setLocalStorage } from "../storage/storage-helpers";
import {
  SPEED_TEST_BYTES_PER_REQ,
  SPEED_TEST_CACHE_TTL_MS,
  SPEED_TEST_FALLBACK,
  SPEED_TEST_MAX_BYTES,
  SPEED_TEST_MAX_DURATION_MS,
  SPEED_TEST_MAX_PER_DAY,
  SPEED_TEST_STREAMS,
  SPEED_TEST_TIMEOUT_MS,
  SPEED_TEST_URL,
  SPEED_TEST_WARMUP_MS,
} from "../constants";

/**
 * Best-effort download bandwidth measurement.
 *
 * Built on Electron's `net` module, so it goes through Chromium's network
 * stack (system proxy, certs, DNS) with no third-party dependency. The test is
 * deliberately kept off the WebSocket connect path: callers read the cached
 * value synchronously and kick off a refresh that is never awaited.
 *
 * Nothing here throws. Every failure path resolves to SPEED_TEST_FALLBACK.
 */

const SPEED_CACHE_KEY = "mellowtel_speed_test_cache";
const SPEED_QUOTA_KEY = "mellowtel_speed_test_quota";

interface SpeedCacheData {
  mbps: number;
  timestamp: number;
}

interface SpeedQuotaData {
  day: string;
  count: number;
}

function parseStored<T>(raw: any): T | null {
  if (!raw) {
    return null;
  }
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as T) : (raw as T);
  } catch {
    return null;
  }
}

function readCache(): SpeedCacheData | null {
  try {
    const data = parseStored<SpeedCacheData>(getLocalStorage(SPEED_CACHE_KEY));
    if (
      typeof data?.mbps !== "number" ||
      typeof data?.timestamp !== "number" ||
      !Number.isFinite(data.mbps) ||
      data.mbps < 0
    ) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function writeCache(mbps: number): void {
  try {
    const data: SpeedCacheData = { mbps, timestamp: Date.now() };
    setLocalStorage(SPEED_CACHE_KEY, data);
  } catch (error) {
    Logger.log(`[MeasureConnectionSpeed]: Could not persist result - ${error}`);
  }
}

function isCacheFresh(cache: SpeedCacheData | null): cache is SpeedCacheData {
  return !!cache && Date.now() - cache.timestamp <= SPEED_TEST_CACHE_TTL_MS;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/// Guards against a reconnect-looping client running a test every hour forever.
function quotaExhausted(): boolean {
  try {
    const data = parseStored<SpeedQuotaData>(getLocalStorage(SPEED_QUOTA_KEY));
    if (data?.day !== today() || typeof data?.count !== "number") {
      return false;
    }
    return data.count >= SPEED_TEST_MAX_PER_DAY;
  } catch {
    return false;
  }
}

function recordAttempt(): void {
  try {
    const data = parseStored<SpeedQuotaData>(getLocalStorage(SPEED_QUOTA_KEY));
    const count =
      data?.day === today() && typeof data?.count === "number" ? data.count + 1 : 1;
    setLocalStorage(SPEED_QUOTA_KEY, { day: today(), count });
  } catch {
    /// Quota accounting is advisory; never block a test because of it.
  }
}

let inFlight: Promise<number> | null = null;
let activeCancel: (() => void) | null = null;

/**
 * Reads the last measured speed. Synchronous and safe to call on the connect
 * path: a miss, a stale entry or a corrupt entry all return the fallback.
 */
export function getCachedSpeed(): number {
  try {
    const cache = readCache();
    return isCacheFresh(cache) ? cache.mbps : SPEED_TEST_FALLBACK;
  } catch {
    return SPEED_TEST_FALLBACK;
  }
}

/**
 * Fire-and-forget refresh. Returns nothing, so there is no promise for a
 * caller to await or leak as an unhandled rejection.
 */
export function refreshSpeedInBackground(): void {
  try {
    if (inFlight) {
      return;
    }
    if (isCacheFresh(readCache())) {
      return;
    }
    /// Electron's `net` module is unusable before the app `ready` event.
    if (!app.isReady()) {
      Logger.log("[MeasureConnectionSpeed]: App not ready, skipping speed test");
      return;
    }
    if (quotaExhausted()) {
      Logger.log("[MeasureConnectionSpeed]: Daily speed test limit reached");
      return;
    }

    recordAttempt();
    Logger.log("[MeasureConnectionSpeed]: Running speed test...");
    inFlight = runSpeedTest()
      .then((mbps) => {
        if (mbps > 0) {
          writeCache(mbps);
          Logger.log(`[MeasureConnectionSpeed]: Download bandwidth: ${mbps} Mbps`);
        } else {
          Logger.log("[MeasureConnectionSpeed]: Speed test produced no reading");
        }
        return mbps;
      })
      .catch((error) => {
        Logger.log(`[MeasureConnectionSpeed]: Speed test failed - ${error}`);
        return SPEED_TEST_FALLBACK;
      })
      .finally(() => {
        inFlight = null;
      });
  } catch (error) {
    inFlight = null;
    Logger.log(`[MeasureConnectionSpeed]: Speed test skipped - ${error}`);
  }
}

/// Aborts an in-flight test so a pending socket cannot fire callbacks into a
/// torn-down process. Safe to call when no test is running.
export function cancelSpeedTest(): void {
  try {
    activeCancel?.();
  } catch {
    /// Nothing to do; the test resolves to the fallback on its own.
  }
}

function runSpeedTest(): Promise<number> {
  return new Promise<number>((resolve) => {
    const requests: Electron.ClientRequest[] = [];
    let timers: NodeJS.Timeout[] = [];
    let settled = false;
    let bytesTotal = 0;
    let bytesAtWarmup = 0;
    let windowStart = 0;
    let streamsEnded = 0;

    const cleanup = () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers = [];
      requests.forEach((request) => {
        try {
          request.abort();
        } catch {
          /// Already finished or aborted.
        }
      });
      requests.length = 0;
      activeCancel = null;
    };

    const settle = (mbps: number) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(mbps);
    };

    /// Resolves with whatever has been measured so far, or the fallback if the
    /// warmup window never elapsed.
    const finish = () => {
      if (settled) {
        return;
      }
      const measuredBytes = bytesTotal - bytesAtWarmup;
      const elapsedSec = windowStart > 0 ? (Date.now() - windowStart) / 1000 : 0;
      if (elapsedSec <= 0 || measuredBytes <= 0) {
        settle(SPEED_TEST_FALLBACK);
        return;
      }
      const mbps = (measuredBytes * 8) / elapsedSec / 1e6;
      settle(Number.isFinite(mbps) ? parseFloat(mbps.toFixed(2)) : SPEED_TEST_FALLBACK);
    };

    const onStreamEnd = () => {
      streamsEnded++;
      if (streamsEnded >= SPEED_TEST_STREAMS) {
        finish();
      }
    };

    activeCancel = finish;

    /// Discarding the warmup excludes TCP slow start, which otherwise drags the
    /// reading well below the real link speed on short transfers.
    timers.push(
      setTimeout(() => {
        bytesAtWarmup = bytesTotal;
        windowStart = Date.now();
        timers.push(setTimeout(finish, SPEED_TEST_MAX_DURATION_MS));
      }, SPEED_TEST_WARMUP_MS)
    );
    timers.push(setTimeout(finish, SPEED_TEST_TIMEOUT_MS));

    for (let i = 0; i < SPEED_TEST_STREAMS; i++) {
      try {
        const url = `${SPEED_TEST_URL}?bytes=${SPEED_TEST_BYTES_PER_REQ}&mt=${Date.now()}-${i}`;
        const request = net.request(url);
        requests.push(request);

        request.on("response", (response) => {
          /// Only a successful body is real throughput. An error page would
          /// otherwise be measured as if it were payload.
          if (response.statusCode < 200 || response.statusCode >= 300) {
            response.on("data", () => undefined);
            response.on("end", onStreamEnd);
            response.on("error", onStreamEnd);
            return;
          }
          response.on("data", (chunk: Buffer) => {
            bytesTotal += chunk.length;
            if (bytesTotal >= SPEED_TEST_MAX_BYTES) {
              finish();
            }
          });
          response.on("end", onStreamEnd);
          response.on("error", onStreamEnd);
        });
        request.on("error", onStreamEnd);
        request.on("abort", onStreamEnd);
        request.end();
      } catch {
        onStreamEnd();
      }
    }
  });
}
