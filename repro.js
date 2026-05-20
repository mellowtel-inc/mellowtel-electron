// Repro script for the "Cannot contact reCAPTCHA" dialog leak.
// Run after `npm install && npm run build`:
//   npx electron repro.js

const { app, session, BrowserWindow } = require('electron');
const { setupMellowtelApp } = require('./dist/utils/app-setup');
const { processUrl } = require('./dist/utils/data-helpers');
const { DataRequest } = require('./dist/utils/data-request');
const { Logger } = require('./dist/logger/logger');

Logger.disableLogs = false;

// Mirror what a host app would do.
setupMellowtelApp();

// Switch between repro modes by changing MODE.
//   'iframe-alert'  -> deterministic: iframe srcdoc calls alert(). Should always pop a dialog.
//   'recaptcha'     -> realistic:    loads Google's reCAPTCHA demo; we block reCAPTCHA at the network layer.
const MODE = 'iframe-alert';

const IFRAME_ALERT_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html><body>
<h1>Repro page</h1>
<iframe srcdoc="<script>alert('Cannot contact reCAPTCHA. Check your connection and try again.');</script>"></iframe>
</body></html>
`)}`;

const RECAPTCHA_PAGE = 'https://www.google.com/recaptcha/api2/demo';

app.whenReady().then(async () => {
  // Keep a visible window open so the app doesn't exit and we can observe any dialog
  const watcher = new BrowserWindow({ width: 480, height: 200 });
  watcher.loadURL(`data:text/html,<h2 style="font-family:sans-serif">Repro running. Watch for a system dialog…</h2>`);

  if (MODE === 'recaptcha') {
    // Block reCAPTCHA on every session (default + pool partitions). This forces
    // the captcha widget's "cannot contact" failure path.
    const blockOn = (s) => {
      s.webRequest.onBeforeRequest(
        { urls: ['*://www.google.com/recaptcha/*', '*://www.gstatic.com/recaptcha/*'] },
        (_, cb) => cb({ cancel: true })
      );
    };
    blockOn(session.defaultSession);
    // Pool windows use session.fromPartition('pool-<id>'), so intercept that pattern too.
    const origFromPartition = session.fromPartition.bind(session);
    session.fromPartition = (...args) => {
      const s = origFromPartition(...args);
      blockOn(s);
      return s;
    };
  }

  const url = MODE === 'iframe-alert' ? IFRAME_ALERT_PAGE : RECAPTCHA_PAGE;

  const req = new DataRequest({
    url,
    orgId: 'repro',
    recordID: 'repro-1',
    waitBeforeScraping: 8, // give the page time to fire the alert / fail reCAPTCHA
    htmlVisualizer: false,
    fullpageScreenshot: false,
    removeCSSselectors: 'none',
    actions: [],
    windowSize: { width: 1280, height: 800 },
    cerealObject: '{"useCereal": false}',
    saveMarkdown: false,
    saveHtml: false,
  });

  Logger.log(`[repro] mode=${MODE}, loading URL via processUrl…`);
  try {
    const result = await processUrl(req);
    Logger.log(`[repro] processUrl returned. HTML length: ${result.html.length}`);
  } catch (e) {
    Logger.error('[repro] processUrl threw:', e && e.message);
  }

  Logger.log('[repro] Done. Leaving app open 20s so you can confirm any dialog. Close manually or wait.');
  setTimeout(() => app.quit(), 20000);
});

app.on('window-all-closed', () => app.quit());
