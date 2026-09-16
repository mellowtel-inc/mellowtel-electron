import type { BrowserWindow } from 'electron';
import { Logger } from '../logger/logger';

/**
 * Captures `fetch`, `XMLHttpRequest`, and `WebSocket` traffic made by a
 * scraped page and ships each capture to the sink named in the job's
 * `burkeObject`. Opt-in per job: absent `burkeObject` means capture is off
 * entirely.
 *
 * SSE (`text/event-stream`) is copied from the page's own body reader. A
 * second tee/clone consumer would share Chromium's BodyStreamBuffer, so a
 * normal chat-client abort would ship an empty capture.
 *
 * WebSocket capture is deliberately generic: it records raw frames (text
 * frames as-is, binary frames as a size marker) exactly as they cross the
 * wire, with no protocol-specific decoding. Sites that speak a custom binary
 * protocol over the socket will show up as opaque `[Binary N bytes]`
 * frames — decoding that is out of scope here, the same way it would be for
 * a binary fetch/XHR response.
 */

/** Hard limit on a sink endpoint request payload. */
const SINK_REQUEST_LIMIT_BYTES = 6_000_000;

/**
 * Body byte cap, in UTF-8 bytes. Deliberately below SINK_REQUEST_LIMIT_BYTES:
 * the capture envelope (headers, url, timings) and JSON escaping both add to
 * the body before it goes on the wire.
 */
export const DEFAULT_MAX_CAPTURE_BYTES = 5_000_000;

/** Upper bound on captures held in the page before we start dropping. */
const MAX_CAPTURES_IN_PAGE = 200;

export interface MeucciConfig {
    /** Record this capture belongs to. The sink keys rows by it. */
    burke_id: string;
    /** Sink URL, taken from the job's burkeObject. */
    api_endpoint: string;
    include_urls: string[];
    exclude_urls: string[];
    max_capture_bytes: number;
}

export interface MeucciHandle {
    /**
     * `cdp`      - injected at document start, sees load-time requests.
     * `fallback` - CDP unavailable; the caller must inject `source` at
     *              dom-ready, which only sees requests fired after that point.
     */
    mode: 'cdp' | 'fallback';
    /** The script body, so a `fallback` caller can executeJavaScript it. */
    source: string;
    detach: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/* glob                                                               */
/* ------------------------------------------------------------------ */

const REGEX_META = /[.*+?^${}()|[\]\\/]/g;

function escapeRegex(literal: string): string {
    return literal.replace(REGEX_META, '\\$&');
}

/**
 * Compiles a URL glob to a regex source string, anchored at both ends and
 * matched against the absolute URL.
 *
 *   `*`   matches any run of characters except `/`
 *   `**`  (or longer) matches anything, including `/`
 *   `/*` or `/**` as the *entire* pattern is the always-matches catch-all
 *
 * Note the consequence of `*` stopping at `/`: a pattern like
 * `https://host/a/b*` will NOT match a URL whose query string contains a
 * literal slash. Use `**` when you mean "and everything after".
 */
export function compileGlob(pattern: string): string {
    if (pattern === '/*' || pattern === '/**') return '^.*$';

    let out = '';
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i];
        if (ch === '*') {
            let run = 0;
            while (pattern[i] === '*') {
                run++;
                i++;
            }
            out += run === 1 ? '[^/]*' : '.*';
            continue;
        }
        // Consume the whole literal run at once.
        let literal = '';
        while (i < pattern.length && pattern[i] !== '*') {
            literal += pattern[i];
            i++;
        }
        out += escapeRegex(literal);
    }
    return `^${out}$`;
}

/** Compiles a list of globs, logging each pattern with its regex. */
export function compileGlobs(patterns: string[], label: string): string[] {
    return patterns.map((pattern) => {
        const source = compileGlob(pattern);
        Logger.log(`[Meucci] compiled ${label} pattern ${JSON.stringify(pattern)} -> ${source}`);
        return source;
    });
}

/** Node-side matcher, exported so the unit tests exercise the real thing. */
export function globMatches(url: string, patterns: string[]): boolean {
    return patterns.some((pattern) => new RegExp(compileGlob(pattern)).test(url));
}

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */

/**
 * Parses a job's `burkeObject` field into a MeucciConfig, or null when
 * capture wasn't requested (absent/empty/invalid) or is missing the one
 * required field (`endpoint`).
 */
export function parseBurkeObject(raw: string | undefined, recordID: string): MeucciConfig | null {
    if (!raw || raw === '{}' || raw === 'null') {
        return null;
    }

    let parsed: any;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        Logger.error(`[Meucci] burkeObject is not valid JSON for ${recordID}, skipping capture: ${e}`);
        return null;
    }

    if (!parsed || typeof parsed !== 'object') {
        Logger.error(`[Meucci] burkeObject for ${recordID} is not an object, skipping capture`);
        return null;
    }

    const endpoint = parsed.endpoint;
    if (!endpoint || typeof endpoint !== 'string') {
        Logger.error(`[Meucci] burkeObject for ${recordID} has no endpoint, skipping capture`);
        return null;
    }

    const include = Array.isArray(parsed.include_urls) && parsed.include_urls.length > 0
        ? parsed.include_urls.map(String)
        : ['/**'];
    const exclude = Array.isArray(parsed.exclude_urls) ? parsed.exclude_urls.map(String) : [];

    const maxBytes = Number(parsed.max_capture_bytes) > 0
        ? Number(parsed.max_capture_bytes)
        : DEFAULT_MAX_CAPTURE_BYTES;

    Logger.log(
        `[Meucci] enabled for ${recordID} -> ${endpoint} ` +
        `include=${JSON.stringify(include)} exclude=${JSON.stringify(exclude)} maxBytes=${maxBytes}`
    );

    return {
        burke_id: recordID,
        api_endpoint: endpoint,
        include_urls: include,
        exclude_urls: exclude,
        max_capture_bytes: maxBytes,
    };
}

/* ------------------------------------------------------------------ */
/* injected script                                                    */
/* ------------------------------------------------------------------ */

/**
 * Builds the IIFE injected into the page's MAIN world.
 *
 * Written as plain ES5-ish string concatenation on purpose: it is embedded in
 * a TS template literal, so template literals inside it would need escaping
 * and that is exactly how subtle bugs get into generated code.
 *
 * Captures accumulate in `window.__MEUCCI_CAPTURED__`; the main process drains
 * that array and POSTs from Node (see `collectAndSendCaptures`).
 */
export function getMeucciScript(config: MeucciConfig): string {
    const pageConfig = {
        burke_id: config.burke_id,
        include: compileGlobs(config.include_urls, 'include'),
        exclude: compileGlobs(config.exclude_urls, 'exclude'),
        max_capture_bytes: config.max_capture_bytes,
        max_captures: MAX_CAPTURES_IN_PAGE,
    };

    return `(function () {
  var CONFIG = ${JSON.stringify(pageConfig)};

  function log(message, data) {
    try {
      console.log('[Meucci] ' + message, data === undefined ? '' : data);
    } catch (e) {}
  }

  // The doc-start script is re-evaluated on every navigation and in every
  // subframe, and the dom-ready fallback can race it. Patching twice would
  // double every capture.
  if (window.__MEUCCI_ACTIVE__) {
    return 'MEUCCI_ALREADY_ACTIVE';
  }
  window.__MEUCCI_ACTIVE__ = true;
  window.__MEUCCI_CONFIG__ = CONFIG;
  window.__MEUCCI_CAPTURED__ = window.__MEUCCI_CAPTURED__ || [];
  window.__MEUCCI_PENDING__ = 0;
  window.__MEUCCI_STATS__ = { seen: 0, matched: 0, skipped: 0, dropped: 0, errors: 0 };

  var isTop = false;
  try { isTop = window.top === window; } catch (e) { isTop = false; }

  var include = [];
  var exclude = [];
  try {
    for (var i = 0; i < CONFIG.include.length; i++) include.push(new RegExp(CONFIG.include[i]));
    for (var j = 0; j < CONFIG.exclude.length; j++) exclude.push(new RegExp(CONFIG.exclude[j]));
  } catch (e) {
    log('failed to compile url filters, capturing nothing', String(e));
    return 'MEUCCI_BAD_FILTERS';
  }

  var BINARY_CONTENT_TYPE = /^(image|video|audio|font)\\/|application\\/(octet-stream|pdf|zip|gzip|wasm)/i;

  function randomId(length) {
    return Math.random().toString(36).substring(2, (length || 6) + 2);
  }

  function absolute(url) {
    var s = String(url);
    try {
      return new URL(s, window.location.href).href;
    } catch (e) {
      if (s.indexOf('http') === 0) return s;
      return window.location.origin + (s.charAt(0) === '/' ? '' : '/') + s;
    }
  }

  function matches(list, url) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].test(url)) return true;
    }
    return false;
  }

  function shouldCapture(fullUrl) {
    window.__MEUCCI_STATS__.seen++;
    if (exclude.length > 0 && matches(exclude, fullUrl)) {
      window.__MEUCCI_STATS__.skipped++;
      log('SKIP (exclude_urls) ' + fullUrl);
      return false;
    }
    if (include.length > 0 && !matches(include, fullUrl)) {
      window.__MEUCCI_STATS__.skipped++;
      log('SKIP (did NOT match include_urls) ' + fullUrl);
      return false;
    }
    window.__MEUCCI_STATS__.matched++;
    return true;
  }

  // Subframes get their own window object, so their captures would never be
  // visible to the main process (which reads the top frame). Forward them.
  if (isTop) {
    window.addEventListener('message', function (event) {
      try {
        var data = event.data;
        if (!data || data.__meucciCapture !== true || typeof data.capture !== 'string') return;
        store(JSON.parse(data.capture));
      } catch (e) {
        log('failed to accept a subframe capture', String(e));
      }
    });
  }

  function store(capture) {
    try {
      if (window.__MEUCCI_CAPTURED__.length >= CONFIG.max_captures) {
        window.__MEUCCI_STATS__.dropped++;
        log('DROP: already holding ' + CONFIG.max_captures + ' captures');
        return;
      }
      window.__MEUCCI_CAPTURED__.push(capture);
      log('captured ' + capture.transport + ' ' + capture.full_url, {
        status: capture.status,
        bytes: capture.responseSize === undefined ? null : capture.responseSize
      });
    } catch (e) {
      log('store failed', String(e));
    }
  }

  function emit(capture) {
    capture.burke_id = CONFIG.burke_id;
    capture.completed = true;
    // Body text is already the bulk of the payload; a parsed copy would double
    // it and can push a large capture past the sink's 6MB request cap.
    if (typeof capture.responseData === 'string' && capture.responseData.length <= 1000000) {
      var trimmed = capture.responseData.replace(/^\\s+/, '');
      if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
        try {
          capture.parsedResponse = JSON.parse(capture.responseData);
        } catch (e) {
          capture.jsonParseError = String(e && e.message ? e.message : e);
        }
      }
    }
    if (isTop) {
      store(capture);
      return;
    }
    try {
      window.top.postMessage({ __meucciCapture: true, capture: JSON.stringify(capture) }, '*');
    } catch (e) {
      log('failed to forward capture from subframe', String(e));
    }
  }

  function pendingUp() { window.__MEUCCI_PENDING__++; }
  function pendingDown() {
    if (window.__MEUCCI_PENDING__ > 0) window.__MEUCCI_PENDING__--;
  }

  function headersToObject(init, input) {
    var out = {};
    function collect(h) {
      if (!h) return;
      try {
        if (Object.prototype.toString.call(h) === '[object Array]') {
          for (var i = 0; i < h.length; i++) out[h[i][0]] = h[i][1];
        } else if (typeof h.forEach === 'function') {
          h.forEach(function (v, k) { out[k] = v; });
        } else {
          for (var k in h) {
            if (Object.prototype.hasOwnProperty.call(h, k)) out[k] = h[k];
          }
        }
      } catch (e) {}
    }
    if (input && typeof input === 'object' && !(input instanceof URL)) collect(input.headers);
    collect(init && init.headers);
    return out;
  }

  function headersToRawString(headers) {
    try {
      var lines = [];
      headers.forEach(function (v, k) { lines.push(k + ': ' + v); });
      return lines.join('\\r\\n');
    } catch (e) {
      return '';
    }
  }

  // Never consume a body the page still needs. Strings and URLSearchParams are
  // safe to read; everything else is described, not read.
  function describeBody(body) {
    if (body === undefined || body === null) return null;
    if (typeof body === 'string') return body;
    try {
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return body.toString();
      }
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        var keys = [];
        body.forEach(function (_v, k) { keys.push(k); });
        return '[FormData fields: ' + keys.join(', ') + ']';
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) return '[Blob body]';
      if (typeof Document !== 'undefined' && body instanceof Document) return '[Document body]';
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return '[Binary body]';
    } catch (e) {}
    return '[Unserializable body]';
  }

  // A Request object's body can only be read by cloning; reading the original
  // would starve the page.
  function readRequestBody(input, init) {
    try {
      if (init && init.body !== undefined && init.body !== null) return null;
      if (!input || typeof input !== 'object' || input instanceof URL) return null;
      if (!input.body || input.bodyUsed) return null;
      return input.clone().text().then(function (t) { return t; }, function () { return null; });
    } catch (e) {
      return null;
    }
  }

  /* ---------------- fetch ---------------- */

  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      var info = null;
      var bodyPromise = null;

      // Nothing in here may throw into the page's call path, and the original
      // fetch has to run even if our own bookkeeping fails.
      try {
        var rawUrl = typeof input === 'string'
          ? input
          : (input instanceof URL ? input.href : (input && input.url));
        var fullUrl = absolute(rawUrl);

        if (shouldCapture(fullUrl)) {
          var method = ((init && init.method) ||
            (input && typeof input === 'object' && input.method) || 'GET');
          info = {
            id: randomId(),
            burke_id: CONFIG.burke_id,
            transport: 'fetch',
            type: 'fetch',
            timestamp: new Date().toISOString(),
            url: rawUrl,
            full_url: fullUrl,
            method: String(method).toUpperCase(),
            async: true,
            user: null,
            headers: headersToObject(init, input),
            sentData: describeBody(init && init.body),
            responseData: null,
            responseHeaders: null,
            status: null,
            statusText: null,
            duration: null,
            error: null
          };
          if (info.sentData === null) bodyPromise = readRequestBody(input, init);
          pendingUp();
        }
      } catch (e) {
        info = null;
        window.__MEUCCI_STATS__.errors++;
        log('fetch pre-flight bookkeeping failed', String(e));
      }

      var started = Date.now();
      var promise;
      try {
        promise = originalFetch.apply(this, arguments);
      } catch (e) {
        if (info) pendingDown();
        throw e;
      }

      if (!info) return promise;

      function ship() {
        if (!bodyPromise) {
          emit(info);
          pendingDown();
          return;
        }
        bodyPromise.then(function (body) {
          if (body !== null && body !== undefined) info.sentData = body;
        })['catch'](function () {}).then(function () {
          emit(info);
          pendingDown();
        });
      }

      return promise.then(function (response) {
        try {
          info.status = response.status;
          info.statusText = response.statusText;
          info.responseHeaders = headersToRawString(response.headers);
          info.duration = Date.now() - started;

          var contentType = '';
          try { contentType = response.headers.get('content-type') || ''; } catch (e) {}

          if (BINARY_CONTENT_TYPE.test(contentType)) {
            info.responseData = '[Binary data]';
            info.contentType = contentType;
            ship();
            return response;
          }

          if (contentType.indexOf('text/event-stream') !== -1) {
            // Do not tee(). Chat clients (Perplexity, ChatGPT) AbortController
            // the fetch when they have enough tokens; that cancels the shared
            // BodyStreamBuffer and the capture branch then ships empty.
            // Return the original Response and copy chunks from the page's
            // own reader so abort still leaves us whatever the page already saw.
            info.type = 'event-stream';
            try {
              attachSseTap(response, info, ship, contentType, started);
            } catch (e) {
              info.bodyReadError = String(e);
              ship();
            }
            return response;
          }

          // clone() must happen before anything consumes the body. The page
          // keeps the original; we read the copy, and never await it here so
          // the page is not delayed by our capture.
          var copy = null;
          try {
            copy = response.clone();
          } catch (e) {
            info.cloneError = String(e);
            ship();
            return response;
          }
          readStream(copy.body, info, ship, contentType, copy);
        } catch (e) {
          window.__MEUCCI_STATS__.errors++;
          log('fetch capture failed', String(e));
          try {
            info.captureError = String(e);
            ship();
          } catch (e2) {}
        }
        return response;
      }, function (err) {
        try {
          info.error = true;
          info.duration = Date.now() - started;
          info.errorMessage = String((err && err.message) || err);
          info.errorTimestamp = new Date().toISOString();
          ship();
        } catch (e) {}
        // Always rethrow: the page must see its own failure unchanged.
        throw err;
      });
    };
    log('fetch patch installed');
  } else {
    log('window.fetch is not a function, fetch capture disabled');
  }

  // Caps an already-materialised string at max_capture_bytes of UTF-8, NOT at
  // that many characters. String.length is UTF-16 code units, so a CJK or
  // emoji-heavy body of N characters can be up to 3x N bytes on the wire, and
  // the cap exists to stay under the sink's 6MB request limit.
  function capByBytes(text) {
    // Fast path: 3 bytes is the worst case per UTF-16 unit, so below this the
    // string cannot possibly exceed the limit and we skip the encode.
    if (text.length * 3 <= CONFIG.max_capture_bytes) {
      return { text: text, truncated: false, bytes: null };
    }
    try {
      var encoded = new TextEncoder().encode(text);
      if (encoded.length <= CONFIG.max_capture_bytes) {
        return { text: text, truncated: false, bytes: encoded.length };
      }
      // Slicing can land mid-codepoint; TextDecoder replaces the partial tail.
      var cut = new TextDecoder().decode(encoded.slice(0, CONFIG.max_capture_bytes));
      return { text: cut, truncated: true, bytes: CONFIG.max_capture_bytes };
    } catch (e) {
      // No TextEncoder: fall back to the conservative character bound rather
      // than shipping something that might blow the sink's limit.
      var chars = Math.floor(CONFIG.max_capture_bytes / 3);
      return { text: text.slice(0, chars), truncated: text.length > chars, bytes: null };
    }
  }

  // SSE capture without a second consumer. Patches this body's getReader so
  // every chunk the page reads is copied into info; abort/cancel still ships
  // the buffer instead of nulling it. Does not cancel the page's reader.
  function attachSseTap(response, info, done, contentType, started) {
    var limit = CONFIG.max_capture_bytes;
    var decoder = new TextDecoder();
    var buffer = '';
    var bytes = 0;
    var shipped = false;
    var tapped = false;
    var stream = response && response.body;

    function finish(reason, err) {
      if (shipped) return;
      shipped = true;
      info.responseData = buffer;
      info.responseSize = buffer.length;
      info.responseBytes = bytes;
      info.contentType = contentType;
      info.duration = Date.now() - started;
      info.streamEnd = reason;
      if (bytes > limit) info.truncated = true;
      if (err) info.bodyReadError = String(err);
      done();
    }

    if (!stream || typeof stream.getReader !== 'function') {
      info.bodyReadError = 'no readable body';
      finish('error');
      return;
    }

    var originalGetReader = stream.getReader.bind(stream);
    stream.getReader = function (options) {
      var reader = originalGetReader(options);
      if (tapped) return reader;
      tapped = true;

      var originalRead = reader.read.bind(reader);
      var originalCancel = reader.cancel && reader.cancel.bind(reader);

      reader.read = function () {
        return originalRead().then(function (chunk) {
          if (!shipped) {
            if (chunk.done) {
              buffer += decoder.decode();
              finish('done');
            } else if (chunk.value) {
              bytes += chunk.value.byteLength;
              if (!info.truncated) {
                buffer += decoder.decode(chunk.value, { stream: true });
                if (bytes > limit) {
                  var capped = capByBytes(buffer);
                  buffer = capped.text;
                  finish('cap');
                }
              }
            }
          }
          return chunk;
        }, function (err) {
          finish('abort', err);
          throw err;
        });
      };

      if (originalCancel) {
        reader.cancel = function (reason) {
          finish('cancel');
          return originalCancel(reason);
        };
      }

      return reader;
    };

    try {
      Object.defineProperty(response, 'body', {
        configurable: true,
        get: function () { return stream; }
      });
    } catch (e) {}
  }

  // Reads a body progressively under a byte cap, so a large or endless stream
  // can neither pin memory nor block the capture forever.
  function readStream(stream, info, done, contentType, fallbackResponse) {
    var limit = CONFIG.max_capture_bytes;
    var shipped = false;

    // responseSize is the character length of what was stored; responseBytes is
    // the UTF-8 size the cap actually governs. They differ on non-Latin bodies.
    function finish(text, truncated, bytes) {
      if (shipped) return;
      shipped = true;
      info.responseData = text;
      info.responseSize = text.length;
      if (bytes !== null && bytes !== undefined) info.responseBytes = bytes;
      info.contentType = contentType;
      if (truncated) info.truncated = true;
      done();
    }

    if (!stream || typeof stream.getReader !== 'function') {
      if (!fallbackResponse) {
        info.bodyReadError = 'no readable body';
        done();
        return;
      }
      fallbackResponse.text().then(function (t) {
        var capped = capByBytes(t);
        finish(capped.text, capped.truncated, capped.bytes);
      }, function (e) {
        info.bodyReadError = String(e);
        done();
      });
      return;
    }

    var reader = stream.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var bytes = 0;

    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) {
          buffer += decoder.decode();
          finish(buffer, false, bytes);
          return;
        }
        // Count the decompressed transfer bytes, which is what we re-encode
        // when the capture is serialised. Exact, and cheaper than encoding.
        bytes += chunk.value.byteLength;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (bytes > limit) {
          // Stop at the first chunk that crosses the line rather than draining
          // a large or endless stream. Overshoot is bounded by one chunk.
          try { reader.cancel(); } catch (e) {}
          finish(buffer, true, bytes);
          return;
        }
        return pump();
      });
    }

    pump()['catch'](function (e) {
      info.bodyReadError = String(e);
      finish(buffer, bytes > limit, bytes);
    });
  }

  /* ---------------- XMLHttpRequest ---------------- */

  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;
  var originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, async, user) {
    try {
      var fullUrl = absolute(url);
      this._meucci = {
        id: randomId(),
        burke_id: CONFIG.burke_id,
        transport: 'xhr',
        type: 'xhr',
        timestamp: new Date().toISOString(),
        url: url,
        full_url: fullUrl,
        method: method,
        async: async !== false,
        user: user || null,
        headers: {},
        sentData: null,
        responseData: null,
        responseHeaders: null,
        status: null,
        statusText: null,
        duration: null,
        error: null
      };
      this._meucciSkip = !shouldCapture(fullUrl);
    } catch (e) {
      this._meucci = null;
      this._meucciSkip = true;
      window.__MEUCCI_STATS__.errors++;
      log('xhr open bookkeeping failed', String(e));
    }
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    try {
      if (this._meucci && !this._meucciSkip) this._meucci.headers[header] = value;
    } catch (e) {}
    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (data) {
    try {
      if (this._meucci && !this._meucciSkip) {
        var info = this._meucci;
        var self = this;
        var started = Date.now();
        info.sentData = describeBody(data);
        info.sendTimestamp = new Date().toISOString();
        pendingUp();
        var settled = false;

        var onLoad = function () {
          if (settled) return;
          settled = true;
          try {
            info.duration = Date.now() - started;
            info.status = self.status;
            info.statusText = self.statusText;
            info.responseHeaders = self.getAllResponseHeaders();
            info.responseType = self.responseType;

            // responseText throws InvalidStateError unless responseType is ''
            // or 'text'. Reading it unconditionally would throw for binary
            // response types.
            var rt = self.responseType;
            if (rt === '' || rt === 'text') {
              // Byte-capped, not character-capped: see capByBytes.
              var capped = capByBytes(self.responseText || '');
              if (capped.truncated) info.truncated = true;
              info.responseData = capped.text;
              info.responseSize = capped.text.length;
              if (capped.bytes !== null) info.responseBytes = capped.bytes;
            } else {
              info.responseData = '[Binary data]';
              info.responseSize = null;
            }
          } catch (e) {
            window.__MEUCCI_STATS__.errors++;
            info.captureError = String(e);
            log('xhr load handler failed', String(e));
          }
          emit(info);
          pendingDown();
        };

        var onFailure = function (kind) {
          return function () {
            if (settled) return;
            settled = true;
            info.error = true;
            info.errorMessage = kind;
            info.duration = Date.now() - started;
            emit(info);
            pendingDown();
          };
        };

        this.addEventListener('load', onLoad);
        this.addEventListener('error', onFailure('network error'));
        this.addEventListener('abort', onFailure('aborted'));
        this.addEventListener('timeout', onFailure('timeout'));
      }
    } catch (e) {
      window.__MEUCCI_STATS__.errors++;
      log('xhr send bookkeeping failed', String(e));
    }
    return originalSend.apply(this, arguments);
  };

  /* ---------------- WebSocket ---------------- */

  // Frame cap per connection: independent of MAX_CAPTURES_IN_PAGE, so one
  // long-lived, chatty socket (a chat stream, a live feed) cannot by itself
  // fill the global capture buffer and crowd out every other transport.
  var MAX_WS_FRAMES_PER_SOCKET = 200;

  if (typeof window.WebSocket === 'function') {
    var OriginalWS = window.WebSocket;
    var originalWsSend = OriginalWS.prototype.send;
    var wsConnections = new WeakMap();

    // Only strings are read as text. Binary frames are described, not
    // decoded: this capture is protocol-agnostic and must not assume any
    // particular wire format inside the bytes.
    function describeWsFrame(data) {
      if (typeof data === 'string') return { data: data, binary: false };
      try {
        if (data instanceof ArrayBuffer) return { data: '[Binary ' + data.byteLength + ' bytes]', binary: true };
        if (ArrayBuffer.isView(data)) return { data: '[Binary ' + data.byteLength + ' bytes]', binary: true };
        if (typeof Blob !== 'undefined' && data instanceof Blob) return { data: '[Binary ' + data.size + ' bytes]', binary: true };
      } catch (e) {}
      return { data: '[Unserializable frame]', binary: true };
    }

    function wsBaseInfo(state, ws, type) {
      return {
        id: randomId(),
        burke_id: CONFIG.burke_id,
        transport: 'websocket',
        type: type,
        timestamp: new Date().toISOString(),
        url: ws.url,
        full_url: state.fullUrl,
        connection_id: state.connectionId,
        method: null,
        status: null,
        error: null
      };
    }

    // Registers listeners on a socket at most once, regardless of whether we
    // saw it via the constructor patch or the prototype.send patch — the
    // latter is the only hook available for a socket the page constructed
    // before this script ran (see the fetch/XHR patches above for the same
    // "always call through, never alter behaviour" principle applied here).
    function ensureTracked(ws) {
      var state = wsConnections.get(ws);
      if (state) return state;
      state = { connectionId: randomId(), frames: 0, skip: false, fullUrl: null };
      wsConnections.set(ws, state);

      try {
        state.fullUrl = absolute(ws.url);
      } catch (e) {
        state.fullUrl = String(ws.url);
      }
      state.skip = !shouldCapture(state.fullUrl);
      if (state.skip) return state;

      try {
        ws.addEventListener('open', function () {
          try { emit(wsBaseInfo(state, ws, 'websocket-open')); } catch (e) {}
        });
        ws.addEventListener('message', function (event) {
          try {
            if (state.frames >= MAX_WS_FRAMES_PER_SOCKET) {
              window.__MEUCCI_STATS__.dropped++;
              return;
            }
            state.frames++;
            var described = describeWsFrame(event.data);
            var info = wsBaseInfo(state, ws, 'websocket-message');
            if (!described.binary) {
              var capped = capByBytes(described.data);
              info.responseData = capped.text;
              info.responseSize = capped.text.length;
              if (capped.truncated) info.truncated = true;
              if (capped.bytes !== null) info.responseBytes = capped.bytes;
            } else {
              info.responseData = described.data;
            }
            emit(info);
          } catch (e) {
            window.__MEUCCI_STATS__.errors++;
            log('ws message capture failed', String(e));
          }
        });
        ws.addEventListener('close', function (event) {
          try {
            var info = wsBaseInfo(state, ws, 'websocket-close');
            info.status = event.code;
            info.statusText = event.reason || null;
            emit(info);
          } catch (e) {}
        });
        ws.addEventListener('error', function () {
          try {
            var info = wsBaseInfo(state, ws, 'websocket-error');
            info.error = true;
            emit(info);
          } catch (e) {}
        });
      } catch (e) {
        log('ws listener attach failed', String(e));
      }
      return state;
    }

    // Patched on the prototype (not just via the constructor wrapper below) so
    // a socket the page created before this script ran is still captured —
    // mirrors the fetch/XHR patches: always call through to the original.
    OriginalWS.prototype.send = function (data) {
      try {
        var state = ensureTracked(this);
        if (!state.skip && state.frames < MAX_WS_FRAMES_PER_SOCKET) {
          state.frames++;
          var described = describeWsFrame(data);
          var info = wsBaseInfo(state, this, 'websocket-send');
          if (!described.binary) {
            var capped = capByBytes(described.data);
            info.sentData = capped.text;
            if (capped.truncated) info.truncated = true;
          } else {
            info.sentData = described.data;
          }
          emit(info);
        }
      } catch (e) {
        window.__MEUCCI_STATS__.errors++;
        log('ws send capture failed', String(e));
      }
      return originalWsSend.apply(this, arguments);
    };

    function PatchedWebSocket(url, protocols) {
      var ws = protocols !== undefined ? new OriginalWS(url, protocols) : new OriginalWS(url);
      ensureTracked(ws);
      return ws;
    }
    PatchedWebSocket.prototype = OriginalWS.prototype;
    PatchedWebSocket.CONNECTING = OriginalWS.CONNECTING;
    PatchedWebSocket.OPEN = OriginalWS.OPEN;
    PatchedWebSocket.CLOSING = OriginalWS.CLOSING;
    PatchedWebSocket.CLOSED = OriginalWS.CLOSED;
    window.WebSocket = PatchedWebSocket;
    log('websocket patch installed');
  } else {
    log('window.WebSocket is not available, websocket capture disabled');
  }

  log('monitoring active', { burke_id: CONFIG.burke_id, top: isTop });
  return 'MEUCCI_INITIALIZED';
})()`;
}

/* ------------------------------------------------------------------ */
/* injection                                                          */
/* ------------------------------------------------------------------ */

/** CDP commands can hang rather than fail; never wait on one indefinitely. */
const CDP_COMMAND_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(
                () => reject(new Error(`${label} did not respond within ${CDP_COMMAND_TIMEOUT_MS}ms`)),
                CDP_COMMAND_TIMEOUT_MS
            )
        ),
    ]);
}

/**
 * Installs the script so it runs *before* the page's own JavaScript, via CDP
 * (`Page.addScriptToEvaluateOnNewDocument`). `dom-ready` is far too late for
 * load-time requests, and a preload script is not an option under
 * `contextIsolation: true` because it would get its own copies of
 * `fetch`/`XMLHttpRequest` and never see the page's.
 *
 * `webContents.debugger` shares its transport with DevTools, so attaching can
 * fail when DevTools is open. Degrades to a dom-ready injection rather than
 * failing the scrape: late-firing requests only, instead of nothing at all.
 */
export async function attachMeucci(win: BrowserWindow, config: MeucciConfig): Promise<MeucciHandle> {
    const source = getMeucciScript(config);
    let attachedByUs = false;
    // Read inside the try: touching webContents on a destroyed window throws,
    // and capture must never be able to fail a scrape that would otherwise work.
    let dbg: Electron.Debugger | null = null;

    try {
        if (win.isDestroyed()) {
            Logger.error(`[Meucci] window already destroyed for ${config.burke_id}, capture disabled`);
            return { mode: 'fallback', source, detach: async () => { } };
        }
        dbg = win.webContents.debugger;
        // Non-null alias so the detach closure below does not have to re-narrow.
        const debuggerRef = dbg;

        // A window that has never navigated has no live frame, and CDP commands
        // sent to it never resolve - not an error, just silence. Prime it with
        // about:blank so `Page.enable` has something to talk to. The doc-start
        // script still applies to every document loaded after this point.
        if (!win.webContents.getURL()) {
            Logger.log('[Meucci] priming window with about:blank so CDP has a live frame');
            await win.loadURL('about:blank');
        }

        if (!debuggerRef.isAttached()) {
            debuggerRef.attach('1.3');
            attachedByUs = true;
        }
        await withTimeout(debuggerRef.sendCommand('Page.enable'), 'Page.enable');
        const { identifier } = await withTimeout(
            debuggerRef.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source }),
            'Page.addScriptToEvaluateOnNewDocument'
        );
        Logger.log(`[Meucci] doc-start script installed via CDP for ${config.burke_id} (id ${identifier})`);

        return {
            mode: 'cdp',
            source,
            detach: async () => {
                try {
                    if (win.isDestroyed() || !debuggerRef.isAttached()) return;
                    // Removing matters for pooled windows: the script persists
                    // across navigations, so the next job would inherit this
                    // job's burke_id and captures would be misattributed.
                    await withTimeout(
                        debuggerRef.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier }),
                        'Page.removeScriptToEvaluateOnNewDocument'
                    );
                    if (attachedByUs) debuggerRef.detach();
                    Logger.log(`[Meucci] detached for ${config.burke_id}`);
                } catch (e) {
                    Logger.error(`[Meucci] detach failed for ${config.burke_id}: ${e}`);
                }
            },
        };
    } catch (e) {
        Logger.error(
            `[Meucci] CDP attach failed for ${config.burke_id}, falling back to dom-ready injection ` +
            `(load-time requests will be missed): ${e}`
        );
        if (attachedByUs && dbg) {
            try { dbg.detach(); } catch (detachError) {
                Logger.error(`[Meucci] rollback detach failed: ${detachError}`);
            }
        }
        return { mode: 'fallback', source, detach: async () => { } };
    }
}

/** Injects the script into an already-loaded page (the fallback path). */
export async function injectMeucciNow(win: BrowserWindow, handle: MeucciHandle): Promise<void> {
    try {
        if (win.isDestroyed()) return;
        const result = await win.webContents.executeJavaScript(handle.source);
        Logger.log(`[Meucci] dom-ready injection result: ${result}`);
    } catch (e) {
        Logger.error(`[Meucci] dom-ready injection failed: ${e}`);
    }
}

/* ------------------------------------------------------------------ */
/* collection                                                         */
/* ------------------------------------------------------------------ */

/** Waits briefly for in-flight body reads to finish before draining. */
async function waitForPending(win: BrowserWindow, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (win.isDestroyed()) return;
        let pending = 0;
        try {
            pending = await win.webContents.executeJavaScript('window.__MEUCCI_PENDING__ || 0');
        } catch (e) {
            Logger.error(`[Meucci] could not read pending count: ${e}`);
            return;
        }
        if (!pending) return;
        Logger.log(`[Meucci] waiting on ${pending} in-flight capture(s)`);
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    Logger.log(`[Meucci] pending captures did not settle within ${timeoutMs}ms, draining anyway`);
}

/**
 * Drains `window.__MEUCCI_CAPTURED__` and POSTs each capture to the sink from
 * the main process. Returns how many were sent.
 */
export async function collectAndSendCaptures(
    win: BrowserWindow,
    config: MeucciConfig,
    settleTimeoutMs = 2000,
): Promise<number> {
    if (win.isDestroyed()) {
        Logger.error(`[Meucci] window already destroyed for ${config.burke_id}, captures lost`);
        return 0;
    }

    await waitForPending(win, settleTimeoutMs);
    if (win.isDestroyed()) {
        Logger.error(`[Meucci] window destroyed while settling for ${config.burke_id}, captures lost`);
        return 0;
    }

    let payload: string;
    try {
        // splice() so anything landing between the read and the clear is not
        // silently dropped.
        payload = await win.webContents.executeJavaScript(`
            (function () {
              var captured = window.__MEUCCI_CAPTURED__ || [];
              var drained = captured.splice(0, captured.length);
              var stats = window.__MEUCCI_STATS__ || null;
              try {
                return JSON.stringify({ captures: drained, stats: stats });
              } catch (e) {
                return JSON.stringify({ captures: [], stats: stats, error: String(e) });
              }
            })()
        `);
    } catch (e) {
        Logger.error(`[Meucci] failed to read captures for ${config.burke_id}: ${e}`);
        return 0;
    }

    let captures: any[] = [];
    let stats: any = null;
    try {
        const parsed = JSON.parse(payload);
        captures = parsed.captures ?? [];
        stats = parsed.stats;
        if (parsed.error) {
            Logger.error(`[Meucci] page could not serialize captures for ${config.burke_id}: ${parsed.error}`);
        }
    } catch (e) {
        Logger.error(`[Meucci] failed to parse captures for ${config.burke_id}: ${e}`);
        return 0;
    }

    // The single most useful line when a run returns nothing: it separates
    // "the filter rejected everything" from "no requests happened at all".
    Logger.log(
        `[Meucci] ${config.burke_id}: ${captures.length} capture(s) to send; ` +
        `page stats ${JSON.stringify(stats)}`
    );

    let sent = 0;
    for (const capture of captures) {
        let body: string;
        try {
            body = JSON.stringify(capture);
        } catch (e) {
            Logger.error(`[Meucci] capture ${capture?.id} is not serializable, dropping: ${e}`);
            continue;
        }
        // Measure the actual request size, not the string length: JSON escaping
        // and multi-byte characters both inflate it past what `length` reports,
        // and the sink has a hard request-size cap.
        const bodyBytes = Buffer.byteLength(body, 'utf8');
        if (bodyBytes > SINK_REQUEST_LIMIT_BYTES) {
            Logger.error(
                `[Meucci] capture ${capture?.id} is ${bodyBytes} bytes, over the sink's ` +
                `${SINK_REQUEST_LIMIT_BYTES}-byte request cap; sending anyway, expect a rejection`
            );
        }
        try {
            const response = await fetch(config.api_endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
            });
            if (!response.ok) {
                Logger.error(
                    `[Meucci] sink rejected capture ${capture?.id} for ${config.burke_id}: ` +
                    `${response.status} ${response.statusText}`
                );
            } else {
                sent++;
                Logger.log(`[Meucci] sent capture ${capture?.id} (${body.length} bytes) -> ${response.status}`);
            }
        } catch (e) {
            Logger.error(`[Meucci] failed to send capture ${capture?.id} for ${config.burke_id}: ${e}`);
        }
    }

    return sent;
}
