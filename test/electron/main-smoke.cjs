// 1.3-T4: run the built job fetch paths inside a real Electron main process
// (app lifecycle, Electron's network stack), not just ELECTRON_RUN_AS_NODE.
// Usage: npm run build && npx electron test/electron/main-smoke.cjs
const { app } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
    const dist = path.join(__dirname, '..', '..', 'dist');
    const { makeFetchRequest, fetchParserContent } = require(path.join(dist, 'utils', 'job-fetch.js'));
    const results = { runtime: { electron: process.versions.electron, node: process.versions.node, type: process.type }, cases: [] };
    const run = async (name, fn, check) => {
        try { const v = await fn(); results.cases.push({ name, pass: check(v, null), detail: v && v.content ? { contentType: v.contentType, bytes: v.content.length } : typeof v }); }
        catch (e) { results.cases.push({ name, pass: check(null, e), detail: { code: e && e.code, stage: e && e.stage } }); }
    };
    const dr = (u) => ({ recordID: 'smoke', method: 'GET', method_endpoint: u, method_payload: 'no_payload' });
    await run('method_endpoint public https', () => makeFetchRequest(dr('https://example.com/')), (v) => !!v && v.content.length > 0 && /Example Domain/.test(v.content.toString()));
    await run('parser_job public https', () => fetchParserContent('https://example.com/'), (v) => !!v && /Example Domain/.test(v.html));
    await run('method_endpoint http→https redirect', () => makeFetchRequest(dr('http://github.com/')), (v) => !!v && v.content.length > 0);
    for (const u of ['http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:3000/', 'http://[::1]/']) {
        await run(`method_endpoint refuses ${u}`, () => makeFetchRequest(dr(u)), (v, e) => !v && e && e.code === 'EGRESS_BLOCKED');
        await run(`parser_job refuses ${u}`, () => fetchParserContent(u), (v, e) => !v && e && e.code === 'EGRESS_BLOCKED');
    }
    await run('bad TLS still rejected', () => makeFetchRequest(dr('https://self-signed.badssl.com/')), (v, e) => !v && e && e.code === 'FETCH_FAILED');
    const failed = results.cases.filter((c) => !c.pass);
    console.log(JSON.stringify(results, null, 2));
    console.log(failed.length ? `SMOKE FAIL (${failed.length})` : `SMOKE PASS (${results.cases.length} cases)`);
    app.exit(failed.length ? 1 : 0);
});
