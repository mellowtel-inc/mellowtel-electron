import { app, BrowserWindow } from "electron";
import { VERSION } from "../../constants";
import { getWindowPool } from "../window-pool";
import { getCerealManager } from "../cereal-manager";
import { getOpenJarWindow } from "../jar";
import { getDailyRequestCount } from "../../storage/request-counter";

export type ConnectionState = "open" | "connecting" | "closing" | "closed";

/** SDK state owned by the WebSocket manager. */
export interface HealthReportInput {
    requestId: string;
    nodeIdentifier: string;
    connectionState: ConnectionState;
    reconnectAttempts: number;
    jobsInProgress: number;
    resetInProgress: boolean;
    startedAt: number;
}

function toMB(bytes: number): number {
    return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/**
 * Memory used by the renderer processes behind the SDK's own windows.
 * Only processes backing SDK windows are counted; each process is counted
 * once even if several windows share it.
 */
function sdkWindowsMemoryMB(windows: BrowserWindow[]): number {
    const pids = new Set<number>();
    for (const win of windows) {
        try {
            if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
                pids.add(win.webContents.getOSProcessId());
            }
        } catch {
            // window went away while reading it
        }
    }
    if (pids.size === 0) {
        return 0;
    }

    let totalKB = 0;
    for (const metric of app.getAppMetrics()) {
        if (pids.has(metric.pid)) {
            totalKB += metric.memory?.workingSetSize ?? 0;
        }
    }
    return toMB(totalKB * 1024);
}

/**
 * Builds a summary of the resources the SDK itself is using: its windows,
 * its jobs and its memory. Read-only; nothing is changed.
 */
export function buildHealthReport(input: HealthReportInput) {
    const poolStats = getWindowPool().getStats();
    const cerealCapacity = getCerealManager().getCapacityInfo();
    const poolWindows = getWindowPool().getOwnedWindows();
    const cerealWindows = getCerealManager().getOwnedWindows();
    const jarWindow = getOpenJarWindow();
    const sdkWindows = [...poolWindows, ...cerealWindows, ...(jarWindow ? [jarWindow] : [])];
    const processMemory = process.memoryUsage();

    return {
        request_id: input.requestId,
        node_identifier: input.nodeIdentifier,
        version: VERSION,
        generated_at: new Date().toISOString(),
        sdk_uptime_ms: input.startedAt ? Date.now() - input.startedAt : 0,
        connection: {
            state: input.connectionState,
            reconnect_attempts: input.reconnectAttempts,
            reset_in_progress: input.resetInProgress,
        },
        jobs: {
            in_progress: input.jobsInProgress,
            completed_today: getDailyRequestCount(),
        },
        windows: {
            total: sdkWindows.length,
            pool: {
                size: poolStats.poolSize,
                in_use: poolStats.inUse,
                available: poolStats.available,
                max_concurrency: poolStats.maxConcurrency,
                items: poolStats.windows.map(w => ({
                    id: w.id,
                    in_use: w.inUse,
                    age_ms: w.age,
                    usage_count: w.usageCount,
                })),
            },
            cereal: {
                windows: cerealWindows.length,
                active_jobs: cerealCapacity.active,
                max_jobs: cerealCapacity.max,
            },
            jar: {
                open: Boolean(jarWindow),
            },
        },
        memory: {
            // The SDK runs inside the app's main process, so this is that
            // process's memory as a whole, not a per-SDK figure.
            main_process_mb: {
                rss: toMB(processMemory.rss),
                heap_used: toMB(processMemory.heapUsed),
                heap_total: toMB(processMemory.heapTotal),
                external: toMB(processMemory.external),
            },
            sdk_windows_mb: sdkWindowsMemoryMB(sdkWindows),
        },
    };
}
