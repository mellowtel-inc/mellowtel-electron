import { app, BrowserWindow } from 'electron';
import MellowtelSDK from 'mellowtel-electron';

function createWindow(): void {
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
}

// When the app is ready, create the window
app.whenReady().then(() => {
  createWindow();
  
  const sdk: MellowtelSDK = new MellowtelSDK('your-publishable-key', {
    disableLogs: false
  });

  sdk.optIn().then((): void => {
    sdk.init();
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
