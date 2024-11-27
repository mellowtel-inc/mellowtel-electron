import { app, BrowserWindow } from 'electron';
import Mellowtel from 'mellowtel-electron';

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
  
  const mellowtel: Mellowtel = new Mellowtel('electrontestkey', {
    disableLogs: false
  });

  await mellowtel.requestConsent(win, "Get 3 months free")
  await mellowtel.init()

  // Enable from the settings page.
  // await sdk.showConsentSettings(win);

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
