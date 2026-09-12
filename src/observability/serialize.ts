const MAX_STRING = 8000;
const MAX_LOG_STRING = 2000;

// Aggregate size budgets. These bound the *total* serialized size of a
// value, on top of the per-string truncation above. Without this, an object
// with many fields/array items (each individually under the per-string
// limit) could still serialize into a multi-MB blob (e.g. a job with a huge
// `actionResults` array or a deeply nested `json` payload).
const MAX_TRACE_EVENT_BYTES = 20_000; // per JobTrace event's `data`
const MAX_RAW_BYTES = 50_000; // per error-report `raw`/context blob

const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const BUDGET_MARKER = '…[omitted: size budget exceeded]';

function truncateString(value: string, max: number): string {
    if (value.length <= max) {
        return value;
    }
    return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

/**
 * Builds a JSON.stringify replacer that enforces both a per-string length
 * cap and a running total-size budget across the whole tree being
 * serialized. Once the budget is exhausted, all subsequent string leaves are
 * replaced with a short marker instead of their (truncated) content, so a
 * single value's serialized size stays bounded regardless of how many
 * fields/array items it has.
 */
function createBudgetedReplacer(maxStringLen: number, maxTotalBytes: number) {
    let budgetUsed = 0;

    return function replacer(_key: string, current: unknown): unknown {
        if (budgetUsed > maxTotalBytes) {
            return BUDGET_MARKER;
        }

        if (typeof current === 'string') {
            const truncated = truncateString(current, maxStringLen);
            budgetUsed += truncated.length;
            return truncated;
        }

        if (typeof Buffer !== 'undefined' && Buffer.isBuffer(current)) {
            return `[Buffer ${current.length} bytes]`;
        }

        if (current instanceof Error) {
            return {
                name: current.name,
                message: truncateString(current.message, maxStringLen),
                stack: current.stack ? truncateString(current.stack, maxStringLen) : undefined,
            };
        }

        if (Array.isArray(current)) {
            if (current.length > MAX_ARRAY_ITEMS) {
                return [
                    ...current.slice(0, MAX_ARRAY_ITEMS),
                    `…[truncated ${current.length - MAX_ARRAY_ITEMS} more items]`,
                ];
            }
            return current;
        }

        if (current && typeof current === 'object') {
            const keys = Object.keys(current as Record<string, unknown>);
            if (keys.length > MAX_OBJECT_KEYS) {
                const limited: Record<string, unknown> = {};
                for (const k of keys.slice(0, MAX_OBJECT_KEYS)) {
                    limited[k] = (current as Record<string, unknown>)[k];
                }
                limited['__truncated__'] = `${keys.length - MAX_OBJECT_KEYS} more keys omitted`;
                return limited;
            }
        }

        return current;
    };
}

export function serializeForTrace(
    value: unknown,
    options: { maxStringLen?: number; maxTotalBytes?: number } = {}
): unknown {
    const { maxStringLen = MAX_LOG_STRING, maxTotalBytes = MAX_TRACE_EVENT_BYTES } = options;
    try {
        return JSON.parse(JSON.stringify(value, createBudgetedReplacer(maxStringLen, maxTotalBytes)));
    } catch {
        return truncateString(String(value), maxStringLen);
    }
}

export function serializeLogData(params: unknown[]): unknown | undefined {
    if (!params.length) {
        return undefined;
    }
    return serializeForTrace(params.length === 1 ? params[0] : params, {
        maxStringLen: MAX_LOG_STRING,
        maxTotalBytes: MAX_TRACE_EVENT_BYTES,
    });
}

export function serializeRaw(value: unknown): unknown {
    return serializeForTrace(value, { maxStringLen: MAX_STRING, maxTotalBytes: MAX_RAW_BYTES });
}
