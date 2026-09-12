export const MAX_ACTIONS = 50;
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000;

export type ActionStatus = "ok" | "skipped" | "timeout" | "failed";
export type OnActionError = "continue" | "abort";
export type SelectorType = "css" | "xpath" | "text" | "role";
export type TypingSpeed = "slow" | "normal" | "fast" | "instant";
export type WaitState = "visible" | "hidden" | "attached";
export type MouseButton = "left" | "right" | "middle";
export type ScrollDirection = "up" | "down" | "left" | "right";
export type ScrollTo = "top" | "bottom" | "element";
export type ClickOffset = "random" | "center";
export type InputStyle = "instant" | "natural";

export interface TypingConfig {
  speed: TypingSpeed;
  delayMs: [number, number];
  wordPauseMs: [number, number];
  punctuationPauseMs: [number, number];
}

export interface Action {
  type: string;
  selector?: string;
  selectorType?: SelectorType;
  frame?: string;
  timeoutMs?: number;
  optional?: boolean;
  force?: boolean;
  input?: InputStyle;
  milliseconds?: number;
  state?: WaitState;
  text?: string;
  button?: MouseButton;
  clickCount?: number;
  offset?: ClickOffset;
  modifiers?: string[];
  all?: boolean;
  hoverMs?: number;
  holdMs?: number;
  value?: string;
  label?: string;
  speed?: TypingSpeed;
  delayMs?: [number, number] | number[];
  wordPauseMs?: [number, number] | number[];
  punctuationPauseMs?: [number, number] | number[];
  instant?: boolean;
  key?: string;
  checked?: boolean;
  direction?: ScrollDirection;
  amount?: number;
  to?: ScrollTo | string | { x: number; y: number };
  fullPage?: boolean;
  name?: string;
  attribute?: string;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  from?: string | { x: number; y: number };
  toPoint?: { x: number; y: number };
  fields?: Array<{ name: string; value: string }>;
}

export interface ActionResult {
  index: number;
  type: string;
  status: ActionStatus;
  durationMs: number;
  reason?: string;
  selector?: string;
  name?: string;
  value?: unknown;
}

export interface ActionJobSettings {
  natural: boolean;
  onActionError: OnActionError;
  actionTimeoutMs: number;
  typing: TypingConfig;
}

export const TYPING_PRESETS: Record<Exclude<TypingSpeed, "instant">, [number, number]> = {
  slow: [90, 200],
  normal: [40, 120],
  fast: [20, 60],
};

export const DEFAULT_TYPING: TypingConfig = {
  speed: "normal",
  delayMs: TYPING_PRESETS.normal,
  wordPauseMs: [80, 250],
  punctuationPauseMs: [120, 280],
};

export function parseActions(raw: unknown): Action[] {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw as Action[];
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseTypingConfig(raw: unknown, natural: boolean): TypingConfig {
  let source = raw;
  if (typeof raw === "string") {
    try {
      source = JSON.parse(raw);
    } catch {
      source = undefined;
    }
  }

  const input = source && typeof source === "object" ? (source as Partial<TypingConfig> & { instant?: boolean }) : {};
  const speed = (input.speed as TypingSpeed) || (natural ? "normal" : "instant");

  let delayMs = DEFAULT_TYPING.delayMs;
  if (Array.isArray(input.delayMs) && input.delayMs.length >= 2) {
    delayMs = [Number(input.delayMs[0]), Number(input.delayMs[1])];
  } else if (speed !== "instant" && TYPING_PRESETS[speed]) {
    delayMs = TYPING_PRESETS[speed];
  }

  return {
    speed,
    delayMs,
    wordPauseMs: pairOrDefault(input.wordPauseMs, DEFAULT_TYPING.wordPauseMs),
    punctuationPauseMs: pairOrDefault(input.punctuationPauseMs, DEFAULT_TYPING.punctuationPauseMs),
  };
}

export function parseNaturalInput(rawInput: unknown): boolean {
  return rawInput === "natural";
}

function pairOrDefault(value: unknown, fallback: [number, number]): [number, number] {
  if (Array.isArray(value) && value.length >= 2) {
    return [Number(value[0]), Number(value[1])];
  }
  return fallback;
}

export function resolveNaturalInput(action: Action, jobNatural: boolean): boolean {
  if (action.input === "natural") {
    return true;
  }
  if (action.input === "instant") {
    return false;
  }
  return jobNatural;
}

export function resolveTyping(action: Action, job: TypingConfig, natural: boolean): TypingConfig {
  const instant = action.instant === true || action.speed === "instant" || (!natural && !action.speed && !action.delayMs);
  if (instant) {
    return { ...job, speed: "instant", delayMs: [0, 0] };
  }

  const speed = (action.speed as TypingSpeed) || job.speed;
  let delayMs = job.delayMs;
  if (Array.isArray(action.delayMs) && action.delayMs.length >= 2) {
    delayMs = [Number(action.delayMs[0]), Number(action.delayMs[1])];
  } else if (action.speed && action.speed !== "instant" && TYPING_PRESETS[action.speed]) {
    delayMs = TYPING_PRESETS[action.speed];
  }

  return {
    speed: speed === "instant" ? "normal" : speed,
    delayMs,
    wordPauseMs: pairOrDefault(action.wordPauseMs, job.wordPauseMs),
    punctuationPauseMs: pairOrDefault(action.punctuationPauseMs, job.punctuationPauseMs),
  };
}

export function normalizeActionType(type: string): string {
  switch (type) {
    case "write":
      return "type";
    case "fill_input":
    case "fill_textarea":
      return "fill";
    default:
      return type;
  }
}
