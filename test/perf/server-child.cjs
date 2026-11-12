// Fixture server for perf tests, run in its own process so the client's
// process.cpuUsage() measures the client only. Sends its port over IPC.
const http = require('http');

const body4k = Buffer.alloc(4096, 120);
const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    req.resume();
    req.on('end', () => {
        if (u.pathname === '/redirect') {
            res.writeHead(Number(u.searchParams.get('status') || 302), { location: u.searchParams.get('to') });
            return res.end('moved');
        }
        if (u.pathname === '/bytes') {
            const n = Number(u.searchParams.get('n') || 4096);
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            return res.end(n === 4096 ? body4k : Buffer.alloc(n, 120));
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
    });
});
server.keepAliveTimeout = 5000;
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
process.on('disconnect', () => process.exit(0));
