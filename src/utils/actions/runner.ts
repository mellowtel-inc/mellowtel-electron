import { BrowserWindow } from "electron";
import TurndownService from "turndown";
import { Logger } from "../../logger/logger";
import {
  Action,
  ActionJobSettings,
  ActionResult,
  DEFAULT_ACTION_TIMEOUT_MS,
  MAX_ACTIONS,
  normalizeActionType,
  resolveNaturalInput,
  resolveTyping,
} from "./types";
import { callPage, isActionable, pointInBox, queryTargets, TargetBox } from "./page-bridge";
import { clickAt, keyEvent, mouseButton, movePointer, PointerState, pressKey, typeText, wheelAt } from "./input";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class ActionStepError extends Error {
  status: ActionResult["status"];
  reason: string;

  constructor(status: ActionResult["status"], reason: string) {
    super(reason);
    this.status = status;
    this.reason = reason;
  }
}

function timeoutMs(action: Action, settings: ActionJobSettings): number {
  return typeof action.timeoutMs === "number" && action.timeoutMs > 0 ? action.timeoutMs : settings.actionTimeoutMs;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new ActionStepError("timeout", "timeout")), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForTargets(
  win: BrowserWindow,
  action: Action,
  settings: ActionJobSettings
): Promise<TargetBox[]> {
  const started = Date.now();
  const limit = timeoutMs(action, settings);
  let last: TargetBox[] = [];

  while (Date.now() - started < limit) {
    const result = await queryTargets(win, {
      selector: action.selector || "",
      selectorType: action.selectorType,
      frame: action.frame,
      all: action.all,
    });
    last = result.targets;
    if (result.found) {
      const needsReveal = result.targets.some((t) => !t.inView || t.covered);
      if (needsReveal && !action.force) {
        await callPage(win, "reveal", {
          selector: action.selector || "",
          selectorType: action.selectorType,
          frame: action.frame,
        });
        await delay(50);
        const revealed = await queryTargets(win, {
          selector: action.selector || "",
          selectorType: action.selectorType,
          frame: action.frame,
          all: action.all,
        });
        last = revealed.targets;
      }
      const ready = last.filter((t) => isActionable(t, action.force).ok);
      if (ready.length > 0 || action.force) {
        return action.force ? last : ready;
      }
    }
    await delay(100);
  }

  if (!last.length) {
    throw new ActionStepError(action.optional ? "skipped" : "timeout", "not_found");
  }
  const reason = isActionable(last[0], false).reason || "not_ready";
  throw new ActionStepError(action.optional ? "skipped" : "timeout", reason);
}

async function waitForNavigation(win: BrowserWindow, ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      win.webContents.removeListener("did-finish-load", onLoad);
      win.webContents.removeListener("did-navigate-in-page", onLoad);
      resolve();
    };
    const onLoad = () => finish();
    win.webContents.once("did-finish-load", onLoad);
    win.webContents.once("did-navigate-in-page", onLoad);
    setTimeout(finish, ms);
  });
}

function resolvePoint(target: string | { x: number; y: number } | undefined): { x: number; y: number } | null {
  if (target && typeof target === "object" && typeof target.x === "number" && typeof target.y === "number") {
    return { x: target.x, y: target.y };
  }
  return null;
}

async function runOne(
  win: BrowserWindow,
  action: Action,
  settings: ActionJobSettings,
  pointer: PointerState,
  snapshots: unknown[]
): Promise<unknown> {
  const type = normalizeActionType(action.type);
  const natural = resolveNaturalInput(action, settings.natural);

  switch (type) {
    case "wait": {
      if (action.selector || action.text) {
        const started = Date.now();
        const limit = timeoutMs(action, settings);
        while (Date.now() - started < limit) {
          const match = await callPage<{ ok: boolean }>(win, "matchesState", {
            selector: action.selector || "body",
            selectorType: action.selectorType,
            frame: action.frame,
            state: action.state || "visible",
            text: action.text,
          });
          if (match.ok) {
            return;
          }
          await delay(100);
        }
        throw new ActionStepError(action.optional ? "skipped" : "timeout", "wait_condition");
      }
      await delay(Math.max(0, Number(action.milliseconds) || 0));
      return;
    }

    case "click":
    case "dblclick": {
      const targets = await waitForTargets(win, action, settings);
      const count = type === "dblclick" ? 2 : action.clickCount ?? 1;
      for (const target of targets) {
        const point = pointInBox(target, action.offset || (natural ? "random" : "center"));
        await clickAt(win, pointer, point, {
          natural: natural,
          button: action.button || "left",
          clickCount: count,
          modifiers: action.modifiers,
          hoverMs: action.hoverMs,
        });
      }
      await waitForNavigation(win, 2000);
      return;
    }

    case "hover": {
      const [target] = await waitForTargets(win, { ...action, all: false }, settings);
      const point = pointInBox(target, action.offset || "center");
      await movePointer(win, pointer, point, natural);
      await delay(action.holdMs ?? (natural ? 200 + Math.random() * 200 : 50));
      return;
    }

    case "fill": {
      if (!action.selector) {
        throw new ActionStepError("failed", "missing_selector");
      }
      const [target] = await waitForTargets(win, { ...action, all: false }, settings);
      await clickAt(win, pointer, pointInBox(target, "center"), {
        natural: natural,
        hoverMs: natural ? 60 : 0,
      });
      const cleared = await callPage<{ ok: boolean }>(win, "clearValue", {
        selector: action.selector,
        selectorType: action.selectorType,
        frame: action.frame,
      });
      if (!cleared.ok) {
        throw new ActionStepError(action.optional ? "skipped" : "failed", "not_found");
      }
      const typing = resolveTyping(action, settings.typing, natural);
      await typeText(win, String(action.value ?? ""), typing);
      return;
    }

    case "type": {
      const typing = resolveTyping(action, settings.typing, natural);
      await typeText(win, String(action.text ?? ""), typing);
      return;
    }

    case "press": {
      if (!action.key) {
        throw new ActionStepError("failed", "missing_key");
      }
      await pressKey(win, action.key, action.modifiers);
      await waitForNavigation(win, 2000);
      return;
    }

    case "select": {
      if (!action.selector) {
        throw new ActionStepError("failed", "missing_selector");
      }
      await waitForTargets(win, { ...action, all: false }, settings);
      const result = await callPage<{ ok: boolean; error?: string; value?: string }>(win, "setSelect", {
        selector: action.selector,
        selectorType: action.selectorType,
        frame: action.frame,
        value: action.value,
        label: action.label,
      });
      if (!result.ok) {
        throw new ActionStepError(action.optional ? "skipped" : "failed", result.error || "select_failed");
      }
      return result.value;
    }

    case "check": {
      const [target] = await waitForTargets(win, { ...action, all: false }, settings);
      const desired = action.checked !== false;
      if (Boolean(target.checked) === desired) {
        return target.checked;
      }
      await clickAt(win, pointer, pointInBox(target, "center"), { natural: natural });
      return desired;
    }

    case "scroll": {
      const metrics = await callPage<{
        ok: boolean;
        scrollTop: number;
        scrollLeft: number;
        scrollHeight: number;
        scrollWidth: number;
        clientHeight: number;
        clientWidth: number;
        targetBox: TargetBox | null;
      }>(win, "scrollMetrics", {
        selector: action.selector,
        selectorType: action.selectorType,
        frame: action.frame,
      });

      if (action.instant || !natural) {
        let top = 0;
        let left = 0;
        const amount = Number(action.amount) || 600;
        if (action.to === "element") {
          await callPage(win, "scrollInstant", { ...action, to: "element" });
          return;
        }
        if (action.to === "top") top = -(metrics.scrollTop || 0);
        else if (action.to === "bottom") top = (metrics.scrollHeight || 0);
        else if (action.direction === "up") top = -amount;
        else if (action.direction === "left") left = -amount;
        else if (action.direction === "right") left = amount;
        else top = amount;
        await callPage(win, "scrollInstant", { top, left, to: action.to, selector: action.selector, selectorType: action.selectorType, frame: action.frame });
        return;
      }

      if (action.to === "element" && action.selector) {
        const [target] = await waitForTargets(win, { ...action, all: false }, settings);
        const viewH = win.getContentBounds().height;
        const viewW = win.getContentBounds().width;
        let guard = 0;
        while (guard++ < 30) {
          const midY = target.y + target.height / 2;
          const midX = target.x + target.width / 2;
          if (midY >= 0 && midY <= viewH && midX >= 0 && midX <= viewW) {
            break;
          }
          const dy = midY < 0 ? 140 : midY > viewH ? -140 : 0;
          const dx = midX < 0 ? 140 : midX > viewW ? -140 : 0;
          await wheelAt(win, pointer, dx, dy);
          await delay(40 + Math.random() * 40);
        }
        return;
      }

      let remainingX = 0;
      let remainingY = 0;
      const amount = Number(action.amount) || 600;
      if (action.to === "top") remainingY = -(metrics.scrollTop || 0);
      else if (action.to === "bottom") remainingY = Math.max(0, (metrics.scrollHeight || 0) - (metrics.clientHeight || 0) - (metrics.scrollTop || 0));
      else if (action.direction === "up") remainingY = -amount;
      else if (action.direction === "left") remainingX = -amount;
      else if (action.direction === "right") remainingX = amount;
      else remainingY = amount;

      while (Math.abs(remainingY) > 8 || Math.abs(remainingX) > 8) {
        const stepY = Math.sign(remainingY) * Math.min(Math.abs(remainingY), 80 + Math.random() * 80);
        const stepX = Math.sign(remainingX) * Math.min(Math.abs(remainingX), 80 + Math.random() * 80);
        await wheelAt(win, pointer, stepX, -stepY);
        remainingY -= stepY;
        remainingX -= stepX;
        await delay(40 + Math.random() * 40);
      }
      return;
    }

    case "screenshot": {
      let image = await win.webContents.capturePage();
      if (action.fullPage) {
        image = await win.webContents.capturePage();
      }
      const png = image.toPNG();
      return { name: action.name, imageBase64: png.toString("base64") };
    }

    case "snapshot": {
      const html = await win.webContents.executeJavaScript("document.documentElement.outerHTML");
      const turndown = new TurndownService({
        headingStyle: "atx",
        codeBlockStyle: "fenced",
        bulletListMarker: "*",
      });
      const markdown = turndown.turndown(html);
      const snap = { name: action.name, html, markdown };
      snapshots.push(snap);
      return snap;
    }

    case "extract_text": {
      if (!action.selector) {
        throw new ActionStepError("failed", "missing_selector");
      }
      const result = await callPage<{ ok: boolean; value?: unknown }>(win, "extractText", {
        selector: action.selector,
        selectorType: action.selectorType,
        frame: action.frame,
        all: action.all,
      });
      if (!result.ok) {
        throw new ActionStepError(action.optional ? "skipped" : "failed", "not_found");
      }
      return result.value;
    }

    case "extract_attribute": {
      if (!action.selector || !action.attribute) {
        throw new ActionStepError("failed", "missing_selector");
      }
      const result = await callPage<{ ok: boolean; value?: unknown }>(win, "extractAttribute", {
        selector: action.selector,
        selectorType: action.selectorType,
        frame: action.frame,
        attribute: action.attribute,
        all: action.all,
      });
      if (!result.ok) {
        throw new ActionStepError(action.optional ? "skipped" : "failed", "not_found");
      }
      return result.value;
    }

    case "extract_json": {
      if (!action.selector) {
        throw new ActionStepError("failed", "missing_selector");
      }
      const result = await callPage<{ ok: boolean; value?: unknown; error?: string }>(win, "extractJson", {
        selector: action.selector,
        selectorType: action.selectorType,
        frame: action.frame,
      });
      if (!result.ok) {
        throw new ActionStepError(action.optional ? "skipped" : "failed", result.error || "not_found");
      }
      return result.value;
    }

    case "mouse_move": {
      const dest = (typeof action.x === "number" && typeof action.y === "number"
        ? { x: action.x, y: action.y }
        : null) || (action.selector
        ? pointInBox((await waitForTargets(win, { ...action, all: false }, settings))[0], "center")
        : null);
      if (!dest) {
        throw new ActionStepError("failed", "missing_target");
      }
      await movePointer(win, pointer, dest, natural);
      return;
    }

    case "mouse_down":
    case "mouse_up": {
      if (action.selector) {
        const [target] = await waitForTargets(win, { ...action, all: false }, settings);
        await movePointer(win, pointer, pointInBox(target, "center"), natural);
      } else if (typeof action.x === "number" && typeof action.y === "number") {
        await movePointer(win, pointer, { x: action.x, y: action.y }, natural);
      }
      await mouseButton(
        win,
        pointer,
        type === "mouse_down" ? "mouseDown" : "mouseUp",
        action.button || "left",
        1,
        action.modifiers
      );
      return;
    }

    case "wheel": {
      const deltaX = Number(action.deltaX) || 0;
      const deltaY = Number(action.deltaY) || 0;
      await movePointer(win, pointer, { x: pointer.x, y: pointer.y }, false);
      await wheelAt(win, pointer, deltaX, -deltaY);
      await delay(50);
      return;
    }

    case "key_down":
    case "key_up": {
      if (!action.key) {
        throw new ActionStepError("failed", "missing_key");
      }
      await keyEvent(win, type === "key_down" ? "keyDown" : "keyUp", action.key, action.modifiers);
      return;
    }

    case "drag": {
      const fromPoint = resolvePoint(action.from) || (typeof action.from === "string"
        ? pointInBox((await waitForTargets(win, { ...action, selector: action.from, all: false }, settings))[0], "center")
        : null);
      const toTarget = (action as Action & { to?: string | { x: number; y: number } }).to;
      const toPoint = resolvePoint(toTarget) || (typeof toTarget === "string"
        ? pointInBox((await waitForTargets(win, { ...action, selector: toTarget, all: false }, settings))[0], "center")
        : null);
      if (!fromPoint || !toPoint) {
        throw new ActionStepError("failed", "missing_target");
      }
      await movePointer(win, pointer, fromPoint, natural);
      await mouseButton(win, pointer, "mouseDown", action.button || "left");
      await delay(natural ? 80 + Math.random() * 80 : 20);
      await movePointer(win, pointer, toPoint, natural);
      await delay(natural ? 40 + Math.random() * 40 : 10);
      await mouseButton(win, pointer, "mouseUp", action.button || "left");
      return;
    }

    case "fill_form":
      throw new ActionStepError("skipped", "deprecated");

    default:
      throw new ActionStepError("skipped", "unknown_type");
  }
}

export async function runActions(win: BrowserWindow, actions: Action[], settings: ActionJobSettings): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  const pointer: PointerState = {
    x: Math.round((win.getContentBounds().width || 800) / 2),
    y: Math.round((win.getContentBounds().height || 600) / 2),
  };
  const snapshots: unknown[] = [];
  const list = actions.slice(0, MAX_ACTIONS);

  for (let index = 0; index < list.length; index++) {
    const action = list[index];
    const started = Date.now();
    const result: ActionResult = {
      index,
      type: action.type,
      status: "ok",
      durationMs: 0,
      selector: action.selector,
      name: action.name,
    };

    try {
      const value = await withTimeout(
        runOne(win, action, settings, pointer, snapshots),
        timeoutMs(action, settings) + 2000
      );
      result.value = value;
      result.status = "ok";
    } catch (error) {
      if (error instanceof ActionStepError) {
        result.status = error.status;
        result.reason = error.reason;
      } else {
        result.status = "failed";
        result.reason = error instanceof Error ? error.message : "error";
      }
      Logger.log(`[actions] ${action.type} ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
    }

    result.durationMs = Date.now() - started;
    results.push(result);

    if ((result.status === "failed" || result.status === "timeout") && settings.onActionError === "abort") {
      break;
    }
  }

  return results;
}

export function defaultJobSettings(): ActionJobSettings {
  return {
    natural: false,
    onActionError: "continue",
    actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
    typing: {
      speed: "normal",
      delayMs: [40, 120],
      wordPauseMs: [80, 250],
      punctuationPauseMs: [120, 280],
    },
  };
}
