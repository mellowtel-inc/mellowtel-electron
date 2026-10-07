import { app, BrowserWindow } from 'electron';
import Mellowtel, { setupMellowtelApp } from '../src/index';
import { cerealMain } from '../src/utils/data-helpers';

// Call BEFORE app.ready to configure command-line flags
setupMellowtelApp();

let mellowtel: Mellowtel | undefined;

function createWindow(): BrowserWindow {
  // Create the browser window
  const win: BrowserWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true
    }
  });

  // Load the index.html file
  win.loadFile('index.html');
  return win
}

// When the app is ready, create the window
app.whenReady().then(async () => {
  let win = createWindow();
  
  mellowtel = new Mellowtel('electrontestkey', {
    disableLogs: false
  });

  await mellowtel.requestConsent(win, "Get 3 months free")
  await mellowtel.init()

  // Optional: the SDK already releases its hidden worker windows when the last
  // host window closes and shuts down on will-quit. Calling shutdown() here
  // just frees everything a little earlier.
  win.on('closed', () => {
    if (process.platform !== 'darwin') {
      void mellowtel?.shutdown();
    }
  });

  // On macOS, create a new window when clicking the dock icon if no windows are open
  app.on('activate', (): void => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit the app when all windows are closed (except on macOS)
app.on('window-all-closed', (): void => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
