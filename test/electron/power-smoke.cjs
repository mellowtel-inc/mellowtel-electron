// Runs bindPower against Electron's real powerMonitor in a real main process: the API it relies on (on,
// removeListener, isOnBatteryPower) exists, events reach the tunnel, and unbinding removes the listeners.
// Usage: npm run build && npx electron test/electron/power-smoke.cjs
const { app, powerMonitor } = require('electron');
const path = require('path');

app.whenReady().then(() => {
    const { bindPower } = require(path.join(__dirname, '..', '..', 'dist', 'proxy', 'power.js'));
    const calls = [];
    const tunnel = { pause: (r) => calls.push(`pause:${r}`), resume: (r) => calls.push(`resume:${r}`) };
    const onBattery = powerMonitor.isOnBatteryPower();
    const before = ['on-battery', 'on-ac', 'suspend', 'resume'].map((e) => powerMonitor.listenerCount(e));
    const unbind = bindPower(powerMonitor, tunnel);
    for (const e of ['suspend', 'resume', 'on-battery', 'on-ac']) powerMonitor.emit(e);
    unbind();
    const after = ['on-battery', 'on-ac', 'suspend', 'resume'].map((e) => powerMonitor.listenerCount(e));
    powerMonitor.emit('suspend');
    const want = [...(onBattery ? ['pause:battery'] : []), 'pause:sleep', 'resume:sleep', 'pause:battery', 'resume:battery'];
    const pass = JSON.stringify(calls) === JSON.stringify(want) && JSON.stringify(before) === JSON.stringify(after);
    console.log(JSON.stringify({ electron: process.versions.electron, onBattery, calls, before, after }));
    console.log(pass ? 'POWER SMOKE PASS' : 'POWER SMOKE FAIL');
    app.exit(pass ? 0 : 1);
});
