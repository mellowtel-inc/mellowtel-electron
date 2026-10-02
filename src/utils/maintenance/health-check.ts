import { app, BrowserWindow, ProcessMetric } from "electron";
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

interface ProcessUsage {
    count: number;
    memory_mb: number;
    cpu_percent: number;
}

/** Window over which CPU usage is measured. */
const CPU_SAMPLE_MS = 1000;

function toMB(bytes: number): number {
    return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/**
 * Totals a set of Electron process metrics. Memory is the working set;
 * CPU is the average usage over the sampling window.
 */
function summarizeProcesses(metrics: ProcessMetric[]): ProcessUsage {
    let memoryKB = 0;
    let cpu = 0;
    for (const metric of metrics) {
        memoryKB += metric.memory?.workingSetSize ?? 0;
        cpu += metric.cpu?.percentCPUUsage ?? 0;
    }
    return {
        count: metrics.length,
        memory_mb: toMB(memoryKB * 1024),
        cpu_percent: Math.round(cpu * 10) / 10,
    };
}

/** App processes grouped by Electron process type (browser, tab, gpu, utility...). */
function usageByProcessType(metrics: ProcessMetric[]): { [type: string]: ProcessUsage } {
    const groups: { [type: string]: ProcessMetric[] } = {};
    for (const metric of metrics) {
        const type = String(metric.type || "unknown").toLowerCase();
        (groups[type] = groups[type] || []).push(metric);
    }
    const result: { [type: string]: ProcessUsage } = {};
    for (const type of Object.keys(groups)) {
        result[type] = summarizeProcesses(groups[type]);
    }
    return result;
}

/** OS process ids of the renderers behind the given windows, each counted once. */
function rendererPids(windows: BrowserWindow[]): Set<number> {
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
    return pids;
}

/**
 * Builds a summary of the resources used by the app the SDK runs in, with
 * the SDK's own share broken out: window counts, jobs, process memory and
 * CPU. Only counts and usage figures are included - no window titles,
 * URLs or page content. Read-only; nothing is changed.
 */
export async function buildHealthReport(input: HealthReportInput) {
    // Electron reports CPU usage relative to the previous metrics call, so
    // take a first sample and measure over a short window.
    app.getAppMetrics();
    await new Promise(resolve => setTimeout(resolve, CPU_SAMPLE_MS));

    const poolStats = getWindowPool().getStats();
    const cerealCapacity = getCerealManager().getCapacityInfo();
    const poolWindows = getWindowPool().getOwnedWindows();
    const cerealWindows = getCerealManager().getOwnedWindows();
    const jarWindow = getOpenJarWindow();
    const sdkWindows = [...poolWindows, ...cerealWindows, ...(jarWindow ? [jarWindow] : [])];
    const allWindows = BrowserWindow.getAllWindows().filter(win => !win.isDestroyed());

    const metrics = app.getAppMetrics();
    const sdkPids = rendererPids(sdkWindows);
    const sdkMetrics = metrics.filter(metric => sdkPids.has(metric.pid));
    const mainMemory = process.memoryUsage();

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
        sdk: {
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
            // Renderer processes behind the SDK's windows.
            processes: summarizeProcesses(sdkMetrics),
        },
        app: {
            windows: {
                total: allWindows.length,
                sdk: sdkWindows.length,
                other: Math.max(allWindows.length - sdkWindows.length, 0),
            },
            // Every process of the app, the SDK's included.
            processes: summarizeProcesses(metrics),
            processes_by_type: usageByProcessType(metrics),
            // The main process is shared by the app and the SDK.
            main_process_mb: {
                rss: toMB(mainMemory.rss),
                heap_used: toMB(mainMemory.heapUsed),
                heap_total: toMB(mainMemory.heapTotal),
                external: toMB(mainMemory.external),
            },
        },
    };
}
