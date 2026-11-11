import { it, expect } from 'vitest';

// Records which runtime the suite ran on (plain Node, or Electron via ELECTRON_RUN_AS_NODE).
it('runtime', () => {
    const v = process.versions as NodeJS.ProcessVersions & { electron?: string };
    console.log(`[runtime] node ${v.node}, electron ${v.electron ?? 'n/a'}, openssl ${v.openssl}`);
    expect(v.node).toBeTruthy();
});
