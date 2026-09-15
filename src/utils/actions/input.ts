import { BrowserWindow } from "electron";
import { TypingConfig } from "./types";

export interface PointerState {
  x: number;
  y: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function randBetween(range: [number, number]): number {
  const min = Math.min(range[0], range[1]);
  const max = Math.max(range[0], range[1]);
  return min + Math.random() * (max - min);
}

function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

export function mapModifiers(modifiers: string[] = []): Array<"shift" | "control" | "alt" | "meta"> {
  const out: Array<"shift" | "control" | "alt" | "meta"> = [];
  for (const raw of modifiers) {
    const m = raw.toLowerCase();
    if (m === "shift") out.push("shift");
    else if (m === "alt") out.push("alt");
    else if (m === "meta" || m === "command") out.push("meta");
    else if (m === "control" || m === "ctrl") out.push("control");
    else if (m === "controlormeta") out.push(process.platform === "darwin" ? "meta" : "control");
  }
  return out;
}

export function mapKeyCode(key: string): { keyCode: string; shift?: boolean } {
  const aliases: Record<string, string> = {
    enter: "Enter",
    return: "Enter",
    "\n": "Enter",
    "\r": "Enter",
    tab: "Tab",
    escape: "Escape",
    esc: "Escape",
    backspace: "Backspace",
    delete: "Delete",
    space: "Space",
    " ": "Space",
    arrowdown: "Down",
    arrowup: "Up",
    arrowleft: "Left",
    arrowright: "Right",
    down: "Down",
    up: "Up",
    left: "Left",
    right: "Right",
  };
  const lower = key.length === 1 ? key : key.toLowerCase();
  if (aliases[lower]) {
    return { keyCode: aliases[lower] };
  }
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return { keyCode: upper, shift: key !== key.toLowerCase() && key === key.toUpperCase() && /[A-Z]/.test(key) };
  }
  return { keyCode: key };
}

export async function movePointer(
  win: BrowserWindow,
  pointer: PointerState,
  to: { x: number; y: number },
  natural: boolean
): Promise<void> {
  const targetX = Math.max(0, Math.round(to.x));
  const targetY = Math.max(0, Math.round(to.y));

  if (!natural) {
    win.webContents.sendInputEvent({ type: "mouseMove", x: targetX, y: targetY });
    pointer.x = targetX;
    pointer.y = targetY;
    return;
  }

  const dist = Math.hypot(targetX - pointer.x, targetY - pointer.y);
  const steps = Math.max(6, Math.min(20, Math.round(dist / 25)));
  const c1 = {
    x: pointer.x + (targetX - pointer.x) * 0.3 + (Math.random() - 0.5) * 40,
    y: pointer.y + (targetY - pointer.y) * 0.1 + (Math.random() - 0.5) * 30,
  };
  const c2 = {
    x: pointer.x + (targetX - pointer.x) * 0.7 + (Math.random() - 0.5) * 40,
    y: pointer.y + (targetY - pointer.y) * 0.9 + (Math.random() - 0.5) * 30,
  };

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(bezier(pointer.x, c1.x, c2.x, targetX, t) + (Math.random() - 0.5) * 2);
    const y = Math.round(bezier(pointer.y, c1.y, c2.y, targetY, t) + (Math.random() - 0.5) * 2);
    win.webContents.sendInputEvent({ type: "mouseMove", x: Math.max(0, x), y: Math.max(0, y) });
    await delay(8 + Math.random() * 16);
  }

  pointer.x = targetX;
  pointer.y = targetY;
}

export async function mouseButton(
  win: BrowserWindow,
  pointer: PointerState,
  type: "mouseDown" | "mouseUp",
  button: "left" | "right" | "middle" = "left",
  clickCount = 1,
  modifiers: string[] = []
): Promise<void> {
  win.webContents.sendInputEvent({
    type,
    x: pointer.x,
    y: pointer.y,
    button,
    clickCount,
    modifiers: mapModifiers(modifiers),
  });
}

export async function clickAt(
  win: BrowserWindow,
  pointer: PointerState,
  to: { x: number; y: number },
  options: {
    natural: boolean;
    button?: "left" | "right" | "middle";
    clickCount?: number;
    modifiers?: string[];
    hoverMs?: number;
  }
): Promise<void> {
  await movePointer(win, pointer, to, options.natural);
  const hover = options.hoverMs === 0 ? 0 : options.hoverMs ?? (options.natural ? 80 + Math.random() * 120 : 0);
  if (hover > 0) {
    await delay(hover);
  }

  const count = options.clickCount ?? 1;
  for (let i = 0; i < count; i++) {
    await mouseButton(win, pointer, "mouseDown", options.button, i + 1, options.modifiers);
    await delay(options.natural ? 40 + Math.random() * 60 : 10);
    await mouseButton(win, pointer, "mouseUp", options.button, i + 1, options.modifiers);
    if (i < count - 1) {
      await delay(options.natural ? 60 + Math.random() * 80 : 20);
    }
  }

  if (options.natural) {
    await delay(50 + Math.random() * 130);
  }
}

export async function wheelAt(
  win: BrowserWindow,
  pointer: PointerState,
  deltaX: number,
  deltaY: number
): Promise<void> {
  win.webContents.sendInputEvent({
    type: "mouseWheel",
    x: pointer.x,
    y: pointer.y,
    deltaX,
    deltaY,
    canScroll: true,
  });
}

export async function keyEvent(
  win: BrowserWindow,
  type: "keyDown" | "keyUp" | "char",
  key: string,
  modifiers: string[] = []
): Promise<void> {
  const mapped = mapKeyCode(key);
  const mods = mapModifiers(modifiers);
  if (mapped.shift && !mods.includes("shift")) {
    mods.push("shift");
  }
  win.webContents.sendInputEvent({
    type,
    keyCode: type === "char" ? key : mapped.keyCode,
    modifiers: mods,
  } as any);
}

// Text carried by the char event (keypress). Enter needs "\r" or the browser
// never submits the form / inserts a line break. Other named keys carry none.
function charTextFor(key: string): string | null {
  if (mapKeyCode(key).keyCode === "Enter") return "\r";
  return key.length === 1 ? key : null;
}

export async function pressKey(win: BrowserWindow, key: string, modifiers: string[] = []): Promise<void> {
  await keyEvent(win, "keyDown", key, modifiers);
  const text = charTextFor(key);
  if (text !== null) {
    await keyEvent(win, "char", text, modifiers);
  }
  await keyEvent(win, "keyUp", key, modifiers);
}

const PUNCTUATION = new Set([".", ",", "!", "?", ";", ":", "/"]);

export async function typeText(win: BrowserWindow, text: string, typing: TypingConfig): Promise<void> {
  const instant = typing.speed === "instant";
  let burstLeft = 0;
  text = text.replace(/\r\n?/g, "\n"); // CRLF must be one Enter, not two

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    await pressKey(win, ch);

    if (instant) {
      continue;
    }

    let pause = randBetween(typing.delayMs);
    if (burstLeft <= 0 && Math.random() < 0.18) {
      burstLeft = 3 + Math.floor(Math.random() * 3);
    }
    if (burstLeft > 0) {
      pause = Math.min(pause, typing.delayMs[0] + (typing.delayMs[1] - typing.delayMs[0]) * 0.35);
      burstLeft--;
    }
    if (ch === " " || ch === "\n") {
      pause += randBetween(typing.wordPauseMs);
    } else if (PUNCTUATION.has(ch)) {
      pause += randBetween(typing.punctuationPauseMs);
    } else if (Math.random() < 0.08) {
      pause += randBetween([40, 120]);
    }
    await delay(pause);
  }
}
