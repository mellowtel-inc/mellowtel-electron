// Lifecycle test harness: does Mellowtel follow the host app's lifetime?
//
// Build:  npm run build && npx tsc example/lifecycle-test.ts --esModuleInterop --module commonjs --moduleResolution node --target ES2020 --strict --skipLibCheck
// Run:    LIFECYCLE_MODE=<mode> electron example/lifecycle-test.js   (unset ELECTRON_RUN_AS_NODE first)
//
// MODE (env LIFECYCLE_MODE):
//   with-shutdown  normal app, calls mellowtel.shutdown() on close, user clicks X   -> app exits
//   no-shutdown    normal app, never calls shutdown(), user clicks X                -> app exits
//   app-quit       normal app, host calls app.quit() directly                       -> app exits
//   idle           nothing happens (used for the external force-kill test)
//   splash         splash window -> main window -> user clicks X                    -> app exits
//   tray-hide      tray app hides its window on X, later quits from the tray        -> stays alive, then exits
//   tray-close     tray app fully closes its window on X, a job arrives, then quit  -> stays alive, then exits
import { app, BrowserWindow } from "electron";
import * as path from "path";
import * as os from "os";
import Mellowtel, { setupMellowtelApp } from "../dist/index";
import { WebSocketManager } from "../dist/websockets";
import { getWindowPool } from "../dist/utils/window-pool";
import { getCerealManager } from "../dist/utils/cereal-manager";
import { executeWithJarWindow } from "../dist/utils/jar";

const MODE = process.env.LIFECYCLE_MODE || "no-shutdown";
const isTray = MODE.startsWith("tray");
const t0 = Date.now();
const log = (msg: string) => console.log(`[LT +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Isolated profile so the test never touches the real example's opt-in state.
app.setPath("userData", path.join(os.tmpdir(), "mellowtel-lifecycle-test"));
setupMellowtelApp();

const wsManager = WebSocketManager.getInstance() as any;
const state = () => {
  const windows = BrowserWindow.getAllWindows().map((w) => `${w.id}:${w.isVisible() ? "visible" : "hidden"}`);
  return `ws=${wsManager.ws ? "connected" : "closed"} windows=[${windows.join(", ")}]`;
};

// Tray apps keep running when all windows are gone; normal apps quit.
app.on("window-all-closed", () => {
  if (isTray) {
    log("EVENT window-all-closed (tray app: stays alive)");
  } else {
    log("EVENT window-all-closed -> app.quit()");
    app.quit();
  }
});
app.on("before-quit", () => log("EVENT before-quit"));
app.on("will-quit", () => log("EVENT will-quit"));
app.on("quit", () => log("EVENT quit"));
process.on("exit", (code) => log(`PROCESS exit code=${code} ws=${wsManager.ws ? "connected" : "closed"}`));

function createHostWindow(title: string): BrowserWindow {
  const win = new BrowserWindow({ width: 600, height: 400, title });
  void win.loadURL(`data:text/html,<h1>${title}</h1>`);
  return win;
}

async function warmWorkers(): Promise<void> {
  // Create every lazily-created worker window, as if jobs had run.
  await getWindowPool().initialize().catch((e) => log(`pool init failed: ${e}`));
  await getCerealManager().initialize().catch((e) => log(`cereal init failed: ${e}`));
  await executeWithJarWindow("https://example.com", async () => undefined).catch((e) => log(`jar warm failed: ${e}`));
}

app.whenReady().then(async () => {
  log(`MODE=${MODE} pid=${process.pid}`);

  let win: BrowserWindow;
  if (MODE === "splash") {
    const splash = createHostWindow("Splash");
    win = createHostWindow("Host main window");
    await pause(500);
    log("host: closing splash (main window already open)");
    splash.close();
  } else {
    win = createHostWindow("Host main window");
  }

  const mellowtel = new Mellowtel("electrontestkey", { disableLogs: true });
  await mellowtel.optIn(); // skip the consent dialog
  await mellowtel.init();
  log("mellowtel.init() done");
  await warmWorkers();
  log(`after warm-up: ${state()}`);

  let quittingFromTray = false;
  if (MODE === "tray-hide") {
    win.on("close", (e) => {
      if (quittingFromTray) return;
      e.preventDefault();
      win.hide();
      log("host: X clicked -> window hidden to tray");
    });
  }
  if (MODE === "with-shutdown") {
    win.on("closed", () => {
      log("host: main window closed -> calling mellowtel.shutdown()");
      void mellowtel.shutdown().then(() => log("mellowtel.shutdown() resolved"));
    });
  }

  setInterval(() => log(`HEARTBEAT ${state()}`), 3000);
  await pause(2000);

  if (MODE === "app-quit") {
    log("ACTION host calls app.quit()");
    app.quit();
    return;
  }
  if (MODE === "idle") {
    log("ACTION none (waiting to be force-killed)");
    return;
  }

  log("ACTION user clicks X on the main window");
  win.close();

  if (!isTray) return;

  await pause(6000);
  log(`tray app still running: ${state()}`);

  if (MODE === "tray-close") {
    log("ACTION a job arrives while the app sits in the tray");
    await wsManager.handleIncomingMessage({ data: JSON.stringify({ type_event: "jar", action: "noop" }) });
    await warmWorkers();
    log(`after job: ${state()}`);
    await pause(3000);
  }

  log("ACTION user clicks Quit in the tray menu");
  quittingFromTray = true;
  app.quit();
});
