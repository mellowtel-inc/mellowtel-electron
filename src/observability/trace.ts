import { AsyncLocalStorage } from 'async_hooks';
import { serializeLogData } from './serialize';
import { JobTraceEvent, JobTraceLevel } from './types';

const MAX_EVENTS = 250;

const storage = new AsyncLocalStorage<JobTrace>();

export class JobTrace {
    readonly startedAt: number = Date.now();
    readonly events: JobTraceEvent[] = [];
    stage: string = 'accepted';
    eventsDropped = 0;
    private seq = 0;

    mark(stage: string, message?: string, data?: unknown): void {
        this.stage = stage;
        this.add('info', message ?? stage, data);
    }

    add(level: JobTraceLevel, message: string, data?: unknown): void {
        if (this.events.length >= MAX_EVENTS) {
            this.eventsDropped += 1;
            return;
        }
        this.seq += 1;
        const ts = Date.now();
        const event: JobTraceEvent = {
            seq: this.seq,
            ts,
            at: new Date(ts).toISOString(),
            level,
            stage: this.stage,
            message: String(message),
        };
        const serialized = data !== undefined ? serializeLogData(Array.isArray(data) ? data : [data]) : undefined;
        if (serialized !== undefined) {
            event.data = serialized;
        }
        this.events.push(event);
    }
}

export function createJobTrace(): JobTrace {
    return new JobTrace();
}

export function currentJobTrace(): JobTrace | undefined {
    return storage.getStore();
}

export function runWithJobTrace<T>(trace: JobTrace, fn: () => Promise<T>): Promise<T> {
    return storage.run(trace, fn);
}
