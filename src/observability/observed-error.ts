import { JobErrorCode } from './types';

export class ObservedError extends Error {
    readonly code: JobErrorCode;
    readonly stage: string;
    readonly raw?: unknown;

    constructor(
        message: string,
        options: { code: JobErrorCode; stage: string; raw?: unknown; cause?: unknown }
    ) {
        super(message);
        this.name = 'ObservedError';
        this.code = options.code;
        this.stage = options.stage;
        this.raw = options.raw;
        if (options.cause !== undefined) {
            (this as Error & { cause?: unknown }).cause = options.cause;
        }
    }
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

export function errorName(error: unknown): string {
    if (error instanceof Error) {
        return error.name;
    }
    return typeof error;
}

export function errorStack(error: unknown): string | undefined {
    if (error instanceof Error && error.stack) {
        return error.stack;
    }
    return undefined;
}
