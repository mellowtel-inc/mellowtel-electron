import { BrowserWindow } from 'electron';
import { Logger } from '../logger/logger';

export async function scrapeUrl(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const win = new BrowserWindow({
            show: false,
            webPreferences: {
                offscreen: true,
                nodeIntegration: false,
                contextIsolation: true,
            },
        });

        win.loadURL(url);

        win.webContents.on('did-finish-load', async () => {
            try {
                const content = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
                Logger.log(`[scrapeUrl]: Scraped content from ${url}`);
                resolve(content);
            } catch (error) {
                Logger.error(`[scrapeUrl]: Error scraping ${url} - ${error}`);
                reject(error);
            } finally {
                win.close();
            }
        });

        win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            Logger.error(`[scrapeUrl]: Failed to load ${url} - ${errorDescription}`);
            reject(new Error(errorDescription));
            win.close();
        });
    });
}