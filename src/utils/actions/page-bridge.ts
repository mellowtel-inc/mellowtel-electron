import { BrowserWindow } from "electron";
import { SelectorType } from "./types";

export interface TargetBox {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  enabled: boolean;
  covered: boolean;
  inView: boolean;
  checked?: boolean;
  tag: string;
}

export interface QueryResult {
  found: boolean;
  count: number;
  targets: TargetBox[];
}

export interface QueryArgs {
  selector: string;
  selectorType?: SelectorType;
  frame?: string;
  all?: boolean;
}

const PAGE_BRIDGE = `function (method, args) {
  function rootDoc(frameSel) {
    if (!frameSel) return { doc: document, offsetX: 0, offsetY: 0 };
    var iframe = document.querySelector(frameSel);
    if (!iframe || !iframe.contentDocument) return null;
    var rect = iframe.getBoundingClientRect();
    return { doc: iframe.contentDocument, offsetX: rect.left, offsetY: rect.top };
  }

  function isVisible(el) {
    var style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function isEnabled(el) {
    return !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  }

  function isInView(el) {
    var r = el.getBoundingClientRect();
    var view = el.ownerDocument.defaultView;
    return r.bottom > 0 && r.right > 0 && r.top < view.innerHeight && r.left < view.innerWidth;
  }

  function isCovered(el) {
    var r = el.getBoundingClientRect();
    var x = r.left + r.width / 2;
    var y = r.top + r.height / 2;
    var view = el.ownerDocument.defaultView;
    if (x < 0 || y < 0 || x > view.innerWidth || y > view.innerHeight) return false;
    var top = el.ownerDocument.elementFromPoint(x, y);
    if (!top) return false;
    return !(el === top || el.contains(top));
  }

  function collect(doc, selector, selectorType) {
    selectorType = selectorType || 'css';
    if (selectorType === 'xpath') {
      var snap = doc.evaluate(selector, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      var nodes = [];
      for (var i = 0; i < snap.snapshotLength; i++) nodes.push(snap.snapshotItem(i));
      return nodes.filter(function (n) { return n && n.nodeType === 1; });
    }
    if (selectorType === 'text') {
      var needle = String(selector).trim().toLowerCase();
      return Array.prototype.slice.call(doc.querySelectorAll('body *')).filter(function (el) {
        if (el.children && el.children.length > 0) return false;
        var t = (el.innerText || el.textContent || '').trim().toLowerCase();
        return t === needle || t.indexOf(needle) !== -1;
      });
    }
    if (selectorType === 'role') {
      var role = String(selector);
      var extras = {
        button: 'button, input[type="button"], input[type="submit"], [role="button"]',
        link: 'a[href], [role="link"]',
        textbox: 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, [contenteditable="true"], [role="textbox"]',
        checkbox: 'input[type="checkbox"], [role="checkbox"]'
      };
      return Array.prototype.slice.call(doc.querySelectorAll(extras[role] || '[role="' + role + '"]'));
    }
    return Array.prototype.slice.call(doc.querySelectorAll(selector));
  }

  function describe(el, index, offsetX, offsetY) {
    var r = el.getBoundingClientRect();
    return {
      index: index,
      x: r.left + offsetX,
      y: r.top + offsetY,
      width: r.width,
      height: r.height,
      visible: isVisible(el),
      enabled: isEnabled(el),
      covered: isCovered(el),
      inView: isInView(el),
      checked: typeof el.checked === 'boolean' ? el.checked : (el.getAttribute('aria-checked') === 'true'),
      tag: (el.tagName || '').toLowerCase()
    };
  }

  function query(a) {
    var ctx = rootDoc(a.frame);
    if (!ctx) return { found: false, count: 0, targets: [] };
    var els = collect(ctx.doc, a.selector, a.selectorType);
    var list = a.all ? els : els.slice(0, 1);
    var targets = list.map(function (el, i) { return describe(el, i, ctx.offsetX, ctx.offsetY); });
    return { found: targets.length > 0, count: els.length, targets: targets };
  }

  function withEl(a, fn) {
    var ctx = rootDoc(a.frame);
    if (!ctx) return { ok: false };
    var els = collect(ctx.doc, a.selector, a.selectorType);
    if (!els.length) return { ok: false };
    return fn(a.all ? els : [els[0]], ctx);
  }

  function extractText(a) {
    return withEl(a, function (els) {
      var values = els.map(function (el) { return (el.innerText || el.textContent || '').trim(); });
      return { ok: true, value: a.all ? values : values[0] };
    });
  }

  function extractAttribute(a) {
    return withEl(a, function (els) {
      var values = els.map(function (el) { return el.getAttribute(a.attribute); });
      return { ok: true, value: a.all ? values : values[0] };
    });
  }

  function extractJson(a) {
    return withEl(a, function (els) {
      var raw = (els[0].textContent || els[0].innerText || '').trim();
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch (e) {
        return { ok: false, error: 'invalid_json' };
      }
    });
  }

  function clearValue(a) {
    return withEl(a, function (els) {
      var el = els[0];
      el.focus();
      if ('value' in el) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return { ok: true };
    });
  }

  function setSelect(a) {
    return withEl(a, function (els) {
      var el = els[0];
      if (el.tagName.toLowerCase() !== 'select') return { ok: false, error: 'not_select' };
      var opts = Array.prototype.slice.call(el.options);
      var match;
      if (a.value != null) {
        match = opts.find(function (o) { return o.value === String(a.value); });
      } else if (a.label != null) {
        match = opts.find(function (o) { return o.text.trim() === String(a.label).trim(); });
      } else {
        return { ok: false, error: 'missing_value' };
      }
      // Look the option up first: assigning an unknown value clears the selection.
      if (!match) return { ok: false, error: 'option_not_found' };
      el.selectedIndex = match.index;
      dispatchInput(el);
      if (el.selectedOptions[0] !== match) return { ok: false, error: 'state_not_applied', value: el.value };
      return { ok: true, value: el.value };
    });
  }

  function dispatchInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function scrollMetrics(a) {
    var ctx = rootDoc(a.frame);
    if (!ctx) return { ok: false };
    var target = a.selector ? collect(ctx.doc, a.selector, a.selectorType)[0] : null;
    var scroller = target && (target.scrollHeight > target.clientHeight + 2 || target.scrollWidth > target.clientWidth + 2)
      ? target
      : (ctx.doc.scrollingElement || ctx.doc.documentElement);
    return {
      ok: true,
      scrollTop: scroller.scrollTop,
      scrollLeft: scroller.scrollLeft,
      scrollHeight: scroller.scrollHeight,
      scrollWidth: scroller.scrollWidth,
      clientHeight: scroller.clientHeight,
      clientWidth: scroller.clientWidth,
      targetBox: target ? describe(target, 0, ctx.offsetX, ctx.offsetY) : null
    };
  }

  function scrollInstant(a) {
    var ctx = rootDoc(a.frame);
    if (!ctx) return { ok: false };
    var target = a.selector ? collect(ctx.doc, a.selector, a.selectorType)[0] : null;
    if (a.to === 'element' && target) {
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      return { ok: true };
    }
    var scroller = target && (target.scrollHeight > target.clientHeight + 2)
      ? target
      : (ctx.doc.scrollingElement || ctx.doc.documentElement);
    if (a.to === 'top') scroller.scrollTo(scroller.scrollLeft, 0);
    else if (a.to === 'bottom') scroller.scrollTo(scroller.scrollLeft, scroller.scrollHeight);
    else scroller.scrollBy(a.left || 0, a.top || 0);
    return { ok: true };
  }

  function matchesState(box, state) {
    if (!box) return state === 'hidden';
    if (state === 'attached') return true;
    if (state === 'hidden') return !box.visible;
    return box.visible;
  }

  var api = {
    query: query,
    extractText: extractText,
    extractAttribute: extractAttribute,
    extractJson: extractJson,
    clearValue: clearValue,
    setSelect: setSelect,
    checkState: function (a) {
      return withEl(a, function (els) {
        var el = els[0];
        if ((el.tagName || '').toLowerCase() === 'label' && el.control) el = el.control;
        var type = String(el.type || '').toLowerCase();
        var native = (el.tagName || '').toLowerCase() === 'input' && (type === 'checkbox' || type === 'radio');
        var role = (el.getAttribute('role') || '').toLowerCase();
        if (!native && !el.hasAttribute('aria-checked') && role !== 'checkbox' && role !== 'radio' && role !== 'switch') {
          return { ok: false, error: 'not_checkable' };
        }
        return { ok: true, checked: native ? el.checked : el.getAttribute('aria-checked') === 'true' };
      });
    },
    elementState: function (a) {
      return withEl(a, function (els) {
        var el = els[0];
        var view = el.ownerDocument.defaultView;
        var r = el.getBoundingClientRect();
        var path = [];
        for (var node = el; node && node.parentElement; node = node.parentElement) {
          path.push(node.tagName + ':' + Array.prototype.indexOf.call(node.parentElement.children, node));
        }
        // Document coordinates, so scrolling alone doesn't count as movement.
        return {
          ok: true,
          state: JSON.stringify({
            value: 'value' in el ? String(el.value) : null,
            x: Math.round(r.left + view.scrollX),
            y: Math.round(r.top + view.scrollY),
            w: Math.round(r.width),
            h: Math.round(r.height),
            children: el.childElementCount,
            text: (el.textContent || '').length,
            path: path.join('/')
          })
        };
      });
    },
    scrollMetrics: scrollMetrics,
    scrollInstant: scrollInstant,
    reveal: function (a) {
      return withEl(a, function (els) {
        els[0].scrollIntoView({ block: 'center', inline: 'nearest' });
        return { ok: true };
      });
    },
    matchesState: function (a) {
      var q = query(a);
      if (a.text) {
        var ctx = rootDoc(a.frame);
        var body = ctx && ctx.doc.body ? (ctx.doc.body.innerText || '') : '';
        if (body.indexOf(a.text) === -1) return { ok: false, found: q.found };
      }
      if (!q.found) return { ok: a.state === 'hidden', found: false };
      return { ok: matchesState(q.targets[0], a.state || 'visible'), found: true, target: q.targets[0] };
    }
  };

  if (!api[method]) return { ok: false, error: 'unknown_method' };
  return api[method](args);
}`;

export async function callPage<T>(win: BrowserWindow, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return win.webContents.executeJavaScript(`(${PAGE_BRIDGE})(${JSON.stringify(method)}, ${JSON.stringify(args)})`);
}

export async function queryTargets(win: BrowserWindow, args: QueryArgs): Promise<QueryResult> {
  return callPage<QueryResult>(win, "query", args as unknown as Record<string, unknown>);
}

export function isActionable(target: TargetBox, force?: boolean): { ok: boolean; reason?: string } {
  if (force) {
    return { ok: true };
  }
  if (!target.visible) {
    return { ok: false, reason: "not_visible" };
  }
  if (!target.enabled) {
    return { ok: false, reason: "not_enabled" };
  }
  if (!target.inView) {
    return { ok: false, reason: "not_in_view" };
  }
  if (target.covered) {
    return { ok: false, reason: "covered" };
  }
  return { ok: true };
}

export function pointInBox(target: TargetBox, offset: "random" | "center" = "random"): { x: number; y: number } {
  const padX = target.width * 0.2;
  const padY = target.height * 0.2;
  if (offset === "center" || target.width < 4 || target.height < 4) {
    return { x: Math.round(target.x + target.width / 2), y: Math.round(target.y + target.height / 2) };
  }
  const x = target.x + padX + Math.random() * Math.max(1, target.width - padX * 2);
  const y = target.y + padY + Math.random() * Math.max(1, target.height - padY * 2);
  return { x: Math.round(x), y: Math.round(y) };
}
