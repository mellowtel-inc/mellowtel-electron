import { app, BrowserWindow } from "electron";
import * as path from "path";
import { Action, ActionJobSettings, DEFAULT_TYPING, runActions } from "../dist/utils/actions";

interface Scenario {
  id: string;
  name: string;
  input?: "instant" | "natural";
  actions: Action[];
  expectStatuses?: Array<"ok" | "skipped" | "timeout" | "failed">;
  expectReasons?: Array<string | undefined>;
  expectPage?: string;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const scenarios: Scenario[] = [
  {
    id: "click",
    name: "single: click Search",
    actions: [{ type: "click", selector: "#go" }],
    expectPage: `document.getElementById('results').textContent.includes('Results for:')`,
  },
  {
    id: "dblclick",
    name: "single: dblclick",
    actions: [{ type: "dblclick", selector: "#dbl" }],
    expectPage: `document.getElementById('dbl').textContent === 'Opened'`,
  },
  {
    id: "hover",
    name: "single: hover menu",
    actions: [{ type: "hover", selector: "#menu", holdMs: 800 }],
    expectPage: `getComputedStyle(document.getElementById('menu-list')).display === 'block'`,
  },
  {
    id: "fill",
    name: "single: fill query",
    actions: [{ type: "fill", selector: "#q", value: "open maps" }],
    expectPage: `document.getElementById('q').value === 'open maps'`,
  },
  {
    id: "type",
    name: "single: click then type",
    actions: [
      { type: "click", selector: "#q" },
      { type: "type", text: "typed text" },
    ],
    expectPage: `document.getElementById('q').value.includes('typed text')`,
  },
  {
    id: "press",
    name: "single: fill + press Enter",
    actions: [
      { type: "fill", selector: "#q", value: "enter submit" },
      { type: "press", key: "Enter" },
    ],
    expectPage: `document.getElementById('results').textContent.includes('enter submit')`,
  },
  {
    id: "select",
    name: "single: select country",
    actions: [{ type: "select", selector: "#country", value: "de" }],
    expectPage: `document.getElementById('country').value === 'de'`,
  },
  {
    id: "check",
    name: "single: check facet",
    actions: [{ type: "check", selector: "#facet", checked: true }],
    expectPage: `document.getElementById('facet').checked === true`,
  },
  {
    id: "scroll",
    name: "single: scroll to footer",
    actions: [{ type: "scroll", to: "element", selector: "#footer-card" }],
    expectPage: `(() => { const r = document.getElementById('footer-card').getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight; })()`,
  },
  {
    id: "wheel",
    name: "single: wheel",
    actions: [{ type: "wheel", deltaY: 400 }],
    expectPage: `window.scrollY > 0`,
  },
  {
    id: "mouse-move",
    name: "single: mouse_move to Load more",
    actions: [{ type: "mouse_move", selector: "#load-more" }],
  },
  {
    id: "extract-text",
    name: "single: extract_text title",
    actions: [{ type: "extract_text", selector: "#title", name: "title" }],
    expectStatuses: ["ok"],
  },
  {
    id: "extract-attr",
    name: "single: extract_attribute href",
    actions: [{ type: "extract_attribute", selector: "#docs-link", attribute: "href", name: "docs" }],
    expectStatuses: ["ok"],
  },
  {
    id: "extract-json",
    name: "single: extract_json",
    actions: [{ type: "extract_json", selector: "#page-json", name: "ld" }],
    expectStatuses: ["ok"],
  },
  {
    id: "snapshot",
    name: "single: snapshot",
    actions: [{ type: "snapshot", name: "mid" }],
    expectStatuses: ["ok"],
  },
  {
    id: "screenshot",
    name: "single: screenshot",
    actions: [{ type: "screenshot", name: "view" }],
    expectStatuses: ["ok"],
  },
  {
    id: "wait",
    name: "single: wait for results after click",
    actions: [
      { type: "fill", selector: "#q", value: "wait me" },
      { type: "click", selector: "#go" },
      { type: "wait", selector: "#results", text: "Results for" },
    ],
    expectPage: `document.getElementById('results').textContent.includes('wait me')`,
  },
  {
    id: "search-combo",
    name: "combo: fill + click + extract",
    actions: [
      { type: "fill", selector: "#q", value: "combo search" },
      { type: "click", selector: "#go" },
      { type: "wait", selector: "#results" },
      { type: "extract_text", selector: "#results", name: "results" },
    ],
    expectPage: `document.getElementById('results').textContent.includes('combo search')`,
  },
  {
    id: "filters-combo",
    name: "combo: select + check + search",
    actions: [
      { type: "select", selector: "#country", label: "Japan" },
      { type: "check", selector: "#facet", checked: true },
      { type: "fill", selector: "#q", value: "tokyo" },
      { type: "press", key: "Enter" },
    ],
    expectPage: `document.getElementById('country').value === 'jp' && document.getElementById('facet').checked && document.getElementById('results').textContent.includes('tokyo')`,
  },
  {
    id: "menu-combo",
    name: "combo: hover + click menu",
    actions: [
      { type: "hover", selector: "#menu", holdMs: 400 },
      { type: "click", selector: "#topic-datasets" },
    ],
    expectPage: `document.getElementById('page-log').textContent.includes('topic=datasets')`,
  },
  {
    id: "feed-combo",
    name: "combo: load more twice + scroll feed",
    actions: [
      { type: "click", selector: "#load-more" },
      { type: "wait", milliseconds: 300 },
      { type: "click", selector: "#load-more" },
      { type: "scroll", selector: "#feed", direction: "down", amount: 200 },
    ],
    expectPage: `document.querySelectorAll('#feed .item').length >= 5`,
  },
  {
    id: "drag",
    name: "combo: drag knob",
    actions: [
      { type: "drag", from: "#knob", to: "#track" },
    ],
    expectPage: `Number(document.getElementById('knob-value').textContent) > 0`,
  },
  {
    id: "human-click",
    name: "natural input: click",
    input: "natural",
    actions: [{ type: "click", selector: "#go", input: "natural" }],
    expectPage: `document.getElementById('results').textContent.includes('Results for:')`,
  },
  {
    id: "human-type",
    name: "natural input: slow fill",
    input: "natural",
    actions: [{ type: "fill", selector: "#q", value: "slow human typing", speed: "slow" }],
    expectPage: `document.getElementById('q').value === 'slow human typing'`,
  },
  {
    id: "mixed-input",
    name: "combo: natural fill + instant scroll",
    input: "natural",
    actions: [
      { type: "fill", selector: "#q", value: "mixed" },
      { type: "click", selector: "#go" },
      { type: "scroll", to: "element", selector: "#footer-card", input: "instant" },
    ],
    expectPage: `document.getElementById('results').textContent.includes('mixed')`,
  },
  {
    id: "optional-miss",
    name: "fail-soft: optional missing click",
    actions: [
      { type: "click", selector: "#does-not-exist", optional: true },
      { type: "click", selector: "#go" },
    ],
    expectStatuses: ["skipped", "ok"],
    expectPage: `document.getElementById('results').textContent.includes('Results for:')`,
  },
  {
    id: "invalid-key",
    name: "invalid: unknown key",
    actions: [
      { type: "press", key: "NotARealKey" },
      { type: "key_down", key: "NotARealKey" },
    ],
    expectStatuses: ["failed", "failed"],
    expectReasons: ["invalid_key", "invalid_key"],
  },
  {
    id: "type-missing",
    name: "invalid: type without text",
    actions: [{ type: "type" }],
    expectStatuses: ["failed"],
    expectReasons: ["missing_text"],
  },
  {
    id: "wait-empty",
    name: "invalid: wait without fields",
    actions: [{ type: "wait" }],
    expectStatuses: ["failed"],
    expectReasons: ["missing_wait_condition"],
  },
  {
    id: "select-missing",
    name: "invalid: select unknown option keeps selection",
    actions: [
      { type: "select", selector: "#country", value: "de" },
      { type: "select", selector: "#country", value: "99" },
      { type: "select", selector: "#country" },
    ],
    expectStatuses: ["ok", "failed", "failed"],
    expectReasons: [undefined, "option_not_found", "missing_value"],
    expectPage: `document.getElementById('country').value === 'de'`,
  },
  {
    id: "check-not-checkbox",
    name: "invalid: check on a text input",
    actions: [{ type: "check", selector: "#q" }],
    expectStatuses: ["failed"],
    expectReasons: ["not_checkable"],
  },
  {
    id: "drag-no-effect",
    name: "invalid: drag that moves nothing",
    actions: [{ type: "drag", from: "#title", to: "#track" }],
    expectStatuses: ["failed"],
    expectReasons: ["no_effect"],
  },
];

function settingsFor(scenario: Scenario): ActionJobSettings {
  return {
    natural: scenario.input === "natural",
    onActionError: "continue",
    actionTimeoutMs: 15000,
    typing: DEFAULT_TYPING,
  };
}

async function setBanner(win: BrowserWindow, text: string): Promise<void> {
  await win.webContents.executeJavaScript(
    `document.getElementById('scenario').textContent = ${JSON.stringify(text)}`
  );
}

async function reloadPlayground(win: BrowserWindow): Promise<void> {
  await win.loadFile(path.join(__dirname, "actions-playground.html"));
  await pause(400);
  await win.webContents.executeJavaScript("window.scrollTo(0, 0)");
}

function resultLooksOk(result: { type: string; status: string; value?: unknown }): boolean {
  if (result.type === "extract_text") {
    return result.status === "ok" && result.value != null && String(result.value).length > 0;
  }
  if (result.type === "extract_attribute") {
    return result.status === "ok" && result.value === "https://example.com/docs";
  }
  if (result.type === "extract_json") {
    return result.status === "ok" && JSON.stringify(result.value) === JSON.stringify({ name: "playground", ok: true });
  }
  if (result.type === "snapshot") {
    const value = result.value as { html?: string; markdown?: string } | undefined;
    return result.status === "ok" && Boolean(value?.html && value?.markdown);
  }
  if (result.type === "screenshot") {
    const value = result.value as { imageBase64?: string } | undefined;
    return result.status === "ok" && Boolean(value?.imageBase64);
  }
  return result.status === "ok";
}

async function judge(
  win: BrowserWindow,
  scenario: Scenario,
  results: Array<{ type: string; status: string; reason?: string; value?: unknown }>
): Promise<{ pass: boolean; notes: string[] }> {
  const notes: string[] = [];

  if (scenario.expectStatuses) {
    const actual = results.map((r) => r.status);
    if (actual.join(",") !== scenario.expectStatuses.join(",")) {
      notes.push(`statuses ${actual.join(",")} != ${scenario.expectStatuses.join(",")}`);
    }
    if (scenario.expectReasons) {
      const reasons = results.map((r) => r.reason ?? "-").join(",");
      const wanted = scenario.expectReasons.map((r) => r ?? "-").join(",");
      if (reasons !== wanted) {
        notes.push(`reasons ${reasons} != ${wanted}`);
      }
    }
  } else {
    results.forEach((result, i) => {
      if (!resultLooksOk(result)) {
        notes.push(`step ${i} ${result.type} ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
      }
    });
  }

  if (scenario.expectPage) {
    const pageOk = await win.webContents.executeJavaScript(scenario.expectPage);
    if (!pageOk) {
      notes.push("page state did not match");
    }
  }

  return { pass: notes.length === 0, notes };
}

async function run(): Promise<void> {
  await app.whenReady();

  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith("-") && !arg.endsWith(".js"));
  const selected = wanted.length
    ? scenarios.filter((s) => wanted.includes(s.id))
    : scenarios;

  if (!selected.length) {
    console.log("Unknown scenario id(s):", wanted.join(", "));
    console.log("Available:", scenarios.map((s) => s.id).join(", "));
    app.quit();
    return;
  }

  console.log(`Running ${selected.length} scenario(s). Watch the window.`);
  console.log("Ids:", selected.map((s) => s.id).join(", "));

  const score: Array<{ id: string; pass: boolean; notes: string[] }> = [];

  for (const scenario of selected) {
    await reloadPlayground(win);
    await setBanner(win, `${scenario.id} — ${scenario.name}`);
    console.log("\n===", scenario.id, "===", scenario.name);

    await pause(800);
    const results = await runActions(win, scenario.actions, settingsFor(scenario));
    const verdict = await judge(win, scenario, results);
    score.push({ id: scenario.id, pass: verdict.pass, notes: verdict.notes });

    console.log(verdict.pass ? "PASS" : "FAIL", verdict.notes.join("; ") || "ok");
    console.log("results:", results.map((r) => `${r.type}:${r.status}${r.reason ? `(${r.reason})` : ""}`).join("  "));

    await setBanner(win, `${scenario.id} ${verdict.pass ? "PASS" : "FAIL"}`);
    await pause(1800);
  }

  const failed = score.filter((s) => !s.pass);
  console.log("\n========== SUMMARY ==========");
  for (const row of score) {
    console.log(`${row.pass ? "PASS" : "FAIL"}  ${row.id}${row.notes.length ? "  — " + row.notes.join("; ") : ""}`);
  }
  console.log(`\n${score.length - failed.length}/${score.length} passed`);
  await setBanner(win, `${score.length - failed.length}/${score.length} passed — close the window`);
  if (process.argv.includes("--exit")) {
    app.quit();
    return;
  }
  console.log("Close the window to exit.");
}

run().catch((error) => {
  console.error(error);
  app.quit();
});

app.on("window-all-closed", () => {
  app.quit();
});
