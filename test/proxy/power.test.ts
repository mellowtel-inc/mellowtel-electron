// Power events → tunnel pause / resume.
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { bindPower, type PowerSource } from '../../src/proxy/power';

function fakes(onBattery = false) {
    const source = Object.assign(new EventEmitter(), { isOnBatteryPower: () => onBattery }) as unknown as PowerSource & EventEmitter;
    const calls: string[] = [];
    const tunnel = { pause: (r: string) => calls.push(`pause:${r}`), resume: (r: string) => calls.push(`resume:${r}`) };
    return { source, calls, tunnel };
}

describe('bindPower', () => {
    it('maps battery / mains and suspend / resume to pause and resume', () => {
        const { source, calls, tunnel } = fakes();
        bindPower(source, tunnel);
        for (const e of ['on-battery', 'on-ac', 'suspend', 'resume']) source.emit(e);
        expect(calls).toEqual(['pause:battery', 'resume:battery', 'pause:sleep', 'resume:sleep']);
    });

    it('pauses at once when started on battery', () => {
        const { source, calls, tunnel } = fakes(true);
        bindPower(source, tunnel);
        expect(calls).toEqual(['pause:battery']);
    });

    it('unbinding removes every listener', () => {
        const { source, calls, tunnel } = fakes();
        const unbind = bindPower(source, tunnel);
        unbind();
        for (const e of ['on-battery', 'on-ac', 'suspend', 'resume']) source.emit(e);
        expect(calls).toEqual([]);
        expect(source.eventNames()).toEqual([]);
    });

    it('does nothing outside an Electron main process', () => {
        const { calls, tunnel } = fakes();
        bindPower(undefined, tunnel)();
        bindPower('/path/to/electron' as unknown as PowerSource, tunnel)();
        expect(calls).toEqual([]);
    });
});
