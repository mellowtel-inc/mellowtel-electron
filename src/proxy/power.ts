/**
 * Pauses the proxy tunnel on battery power and before sleep, and resumes it on
 * mains power and after wake. `source` is Electron's powerMonitor (main
 * process only); returns a function that removes the listeners.
 */
export type PowerEvent = 'on-battery' | 'on-ac' | 'suspend' | 'resume';

export interface PowerSource {
    on(event: PowerEvent, listener: () => void): unknown;
    removeListener(event: PowerEvent, listener: () => void): unknown;
    isOnBatteryPower?: () => boolean;
}

export interface Pausable {
    pause(reason: 'battery' | 'sleep'): void;
    resume(reason: 'battery' | 'sleep'): void;
}

export function bindPower(source: PowerSource | undefined | null, tunnel: Pausable): () => void {
    if (!source || typeof source.on !== 'function') return () => undefined; // not in an Electron main process
    const handlers: Array<[PowerEvent, () => void]> = [
        ['on-battery', () => tunnel.pause('battery')],
        ['on-ac', () => tunnel.resume('battery')],
        ['suspend', () => tunnel.pause('sleep')],
        ['resume', () => tunnel.resume('sleep')],
    ];
    for (const [event, handler] of handlers) source.on(event, handler);
    try {
        if (source.isOnBatteryPower?.()) tunnel.pause('battery');
    } catch {
        // older Electron without isOnBatteryPower: the on-battery event still applies
    }
    return () => {
        for (const [event, handler] of handlers) source.removeListener(event, handler);
    };
}
