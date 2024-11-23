import { app, BrowserWindow } from 'electron';
import MellowtelSDK from './index';

let mainWindow: BrowserWindow | null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
    },
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.openDevTools();
}

app.on('ready', async () => {
  createWindow();

  const sdk = new MellowtelSDK('electrontestkey', { disableLogs: false });
  await sdk.init();
  console.log('Mellowtel SDK version:', sdk.getVersion());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});