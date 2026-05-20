// Repro Test 1: top-frame inline alert
//
// What this proves: a page that calls window.alert() from a top-frame inline
// <script> can leak a native OS dialog through the SDK's hidden pool window.
// If a dialog pops with "Cannot contact reCAPTCHA. Check your connection and
// try again." then the SDK's window.alert override (injected on
// did-start-loading) is losing the race against inline scripts on this
// platform.
//
// How to run:
//   npm install
//   npm run build
//   npx electron repro-test1.js
//
// Expected on the affected platform: a native OS dialog appears with the
// message above. The watcher window stays open for 30s so you can confirm
// and screenshot.

const { app, BrowserWindow } = require('electron');
const { setupMellowtelApp } = require('./dist/src/utils/app-setup');
const { processUrl } = require('./dist/src/utils/data-helpers');
const { DataRequest } = require('./dist/src/utils/data-request');
const { Logger } = require('./dist/src/logger/logger');

Logger.disableLogs = false;
setupMellowtelApp();

const URL = 'data:text/html,<script>alert("Cannot contact reCAPTCHA. Check your connection and try again.")</script>';

app.whenReady().then(async () => {
  const watcher = new BrowserWindow({ width: 520, height: 220 });
  watcher.loadURL(
    'data:text/html,<h2 style="font-family:sans-serif;padding:20px">' +
    'Repro Test 1 running. Watch for a native OS dialog…</h2>'
  );

  const req = new DataRequest({
    url: URL,
    orgId: 'repro',
    recordID: 'repro-test1',
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

  Logger.log('[repro-test1] calling processUrl…');
  try {
    const result = await processUrl(req);
    Logger.log(`[repro-test1] processUrl returned. HTML length: ${result.html.length}`);
  } catch (e) {
    Logger.error('[repro-test1] processUrl threw:', e && e.message);
  }

  Logger.log('[repro-test1] Done. Quitting in 30s. Close the watcher window to quit sooner.');
  setTimeout(() => app.quit(), 30000);
});

app.on('window-all-closed', () => app.quit());
