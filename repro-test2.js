// Repro Test 2: iframe srcdoc alert
//
// What this proves: a page that calls window.alert() from a script inside an
// iframe (srcdoc) can leak a native OS dialog through the SDK's hidden pool
// window. The SDK's window.alert override is injected via
// webContents.executeJavaScript, which only patches the main frame. Iframes
// keep their original alert/confirm/prompt — so reCAPTCHA's own iframe (which
// is cross-origin from www.google.com) is unprotected.
//
// How to run:
//   npm install
//   npm run build
//   npx electron repro-test2.js
//
// Expected on the affected platform: a native OS dialog appears with the
// "Cannot contact reCAPTCHA…" message. The watcher window stays open for 30s
// so you can confirm and screenshot.

const { app, BrowserWindow } = require('electron');
const { setupMellowtelApp } = require('./dist/src/utils/app-setup');
const { processUrl } = require('./dist/src/utils/data-helpers');
const { DataRequest } = require('./dist/src/utils/data-request');
const { Logger } = require('./dist/src/logger/logger');

Logger.disableLogs = false;
setupMellowtelApp();

const URL =
  'data:text/html,<iframe srcdoc=\'<script>alert("Cannot contact reCAPTCHA. Check your connection and try again.")</script>\'></iframe>';

app.whenReady().then(async () => {
  const watcher = new BrowserWindow({ width: 520, height: 220 });
  watcher.loadURL(
    'data:text/html,<h2 style="font-family:sans-serif;padding:20px">' +
    'Repro Test 2 running. Watch for a native OS dialog…</h2>'
  );

  const req = new DataRequest({
    url: URL,
    orgId: 'repro',
    recordID: 'repro-test2',
    waitBeforeScraping: 5,
    htmlVisualizer: false,
    fullpageScreenshot: false,
    removeCSSselectors: 'none',
    actions: [],
    windowSize: { width: 1280, height: 800 },
    cerealObject: '{"useCereal": false}',
    saveMarkdown: false,
    saveHtml: false,
  });

  Logger.log('[repro-test2] calling processUrl…');
  try {
    const result = await processUrl(req);
    Logger.log(`[repro-test2] processUrl returned. HTML length: ${result.html.length}`);
  } catch (e) {
    Logger.error('[repro-test2] processUrl threw:', e && e.message);
  }

  Logger.log('[repro-test2] Done. Quitting in 30s. Close the watcher window to quit sooner.');
  setTimeout(() => app.quit(), 30000);
});

app.on('window-all-closed', () => app.quit());
