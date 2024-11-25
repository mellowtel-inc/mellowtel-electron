"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const index_1 = __importDefault(require("./index"));
let mainWindow;
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
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
electron_1.app.on('ready', async () => {
    createWindow();
    const sdk = new index_1.default('electrontestkey', { disableLogs: false });
    if (!sdk.getOptInStatus()) {
        await sdk.optIn();
    }
    await sdk.init();
    console.log('Mellowtel SDK version:', sdk.getVersion());
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
electron_1.app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});
