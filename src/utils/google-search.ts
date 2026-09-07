// Google-specific navigation for processUrl.
//
// Navigating straight to google.<tld>/search?q=... reliably gets the request
// a degraded response - Google explicitly declines to render the AI Overview
// ("Can't generate an AI overview right now"), even without an outright
// /sorry/ block. The generic stealth-injection script processUrl applies to
// every URL makes this worse: Google's fraud scoring fingerprints exactly the
// patches the script applies (navigator.webdriver, fabricated plugins, etc),
// so a stealth-patched browser is flagged regardless of how the page is
// reached. Driving the search the way a person does - load the homepage,
// type the query, press Enter - with no stealth script at all is what
// reliably gets a real, live-rendered Overview (verified: 50/50 real
// Overviews captured across a batch test using this route, vs 0/4 real
// Overviews via direct navigation + stealth).
//
// processUrl uses this for Google search URLs only; every other URL is
// unaffected.

import { BrowserWindow } from 'electron';

// google.com, google.de, google.co.uk, ... after a leading "www." is
// trimmed. Label lengths are capped at 3 so a lookalike like
// "google.evil.com" cannot match.
const GOOGLE_SEARCH_HOST = /^google\.[a-z]{2,3}(\.[a-z]{2,3})?$/;

const SEARCH_BOX_SELECTOR = 'textarea[name=q], input[name=q]';
const SEARCH_BOX_TIMEOUT_MS = 15_000;

/** True when rawUrl is a Google web search (google.<tld>/search with a q). */
export function isGoogleSearchUrl(rawUrl: string): boolean {
  return googleSearchQuery(rawUrl) !== null;
}

/** The human search query, or null when rawUrl is not a Google search. */
export function googleSearchQuery(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!GOOGLE_SEARCH_HOST.test(host)) return null;
    if (u.pathname !== '/search') return null;
    // searchParams already percent-decodes and turns "+" into spaces.
    const q = (u.searchParams.get('q') ?? '').trim();
    if (!q) return null;
    // Newlines would submit the form early.
    return q.replace(/[\r\n]+/g, ' ');
  } catch {
    return null;
  }
}

/** The homepage for a search URL, preserving the locale TLD. */
function googleHomeUrl(rawUrl: string): string {
  const u = new URL(rawUrl);
  return `${u.protocol || 'https:'}//${u.host}/`;
}

// Finds and clicks one cookie-consent control, preferring "Reject all" so we
// do not opt into tracking. Known ids first (Google search: #W0wltc reject,
// #L2AGLb accept), then a reject-all label match across EU languages.
const CONSENT_CLICK_JS = `(() => {
  const vis = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') === 0) return false;
    if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const tryClick = (el, how) => {
    if (!vis(el)) return '';
    try { el.click(); return how; } catch (e) { return ''; }
  };
  for (const id of ['#W0wltc', '#reject-button', '#L2AGLb', '#accept-button']) {
    const el = document.querySelector(id);
    if (el) { const r = tryClick(el, 'id:' + id); if (r) return r; }
  }
  const needles = ['reject all', 'alle ablehnen', 'alles afwijzen', 'tout refuser',
    'rechazar todo', 'rifiuta tutto', 'reject the use of cookies'];
  for (const el of document.querySelectorAll('button, input[type=submit], [role=button]')) {
    const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
    if (needles.some((n) => label.includes(n))) {
      const r = tryClick(el, 'label');
      if (r) return r;
    }
  }
  return '';
})()`;

/** Best-effort single consent click; a miss is fine, the caller polls after. */
async function dismissGoogleConsent(win: BrowserWindow, log: (msg: string) => void): Promise<void> {
  try {
    const via = await win.webContents.executeJavaScript(CONSENT_CLICK_JS, true);
    if (via) log(`dismissed google consent via ${via}`);
  } catch {
    // Non-fatal: the search-box poll below simply times out on a miss.
  }
}

const waitFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the search box exists, or the timeout elapses. */
async function waitForSearchBox(win: BrowserWindow, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const found = await win.webContents.executeJavaScript(
        `!!document.querySelector(${JSON.stringify(SEARCH_BOX_SELECTOR)})`, true);
      if (found) return true;
    } catch {
      // Navigation in flight; retry.
    }
    await waitFor(300);
  }
  return false;
}

/**
 * Loads the Google homepage (no stealth script), clears any consent wall,
 * types the query and submits it. Returns false when any step fails so the
 * caller can fall back to direct navigation - never worse than plain loadURL.
 */
export async function navigateGoogleTypedSearch(
  win: BrowserWindow,
  targetUrl: string,
  query: string,
  log: (msg: string) => void
): Promise<boolean> {
  try {
    await win.loadURL(googleHomeUrl(targetUrl));
  } catch (error) {
    log(`typed-search homepage load failed: ${error}`);
    return false;
  }

  await dismissGoogleConsent(win, log);

  if (!(await waitForSearchBox(win, SEARCH_BOX_TIMEOUT_MS))) {
    log('typed-search search box not found');
    return false;
  }

  try {
    await win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(SEARCH_BOX_SELECTOR)});
        if (!el) return false; el.focus(); return true; })()`, true);
  } catch (error) {
    log(`typed-search focus failed: ${error}`);
    return false;
  }

  const navigated = new Promise<boolean>((resolve) => {
    const done = () => { cleanup(); resolve(true); };
    const timer = setTimeout(() => { cleanup(); resolve(false); }, SEARCH_BOX_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      win.webContents.off('did-finish-load', done);
    };
    win.webContents.once('did-finish-load', done);
  });

  // insertText/sendInputEvent go through Chromium's real input pipeline -
  // Google's search JS listens for genuine key events, so setting .value
  // directly submits an empty query.
  win.webContents.insertText(query);
  await waitFor(150);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' } as any);
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' } as any);
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' } as any);

  if (!(await navigated)) {
    log('typed-search results navigation timed out');
    return false;
  }
  log(`typed-search submitted, final url ${win.webContents.getURL()}`);
  return true;
}
