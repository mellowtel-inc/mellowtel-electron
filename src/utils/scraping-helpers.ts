import { BrowserWindow } from 'electron';
import { Logger } from '../logger/logger';
import TurndownService from 'turndown';


export async function scrapeUrl(url: string): Promise<{ html: string, markdown: string }> {
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

                // Initialize TurndownService
                const turndownService = new TurndownService({
                    headingStyle: 'atx',
                    codeBlockStyle: 'fenced',
                    bulletListMarker: '*'
                });
                
                // Convert HTML to Markdown
                let markdown = turndownService.turndown(content);

                resolve({ html: content, markdown: markdown });
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


export async function getS3SignedUrls(recordID: string): Promise<{ uploadURL_html: string; uploadURL_markDown: string; }> {
    const response = await fetch(`https://5xub3rkd3rqg6ebumgrvkjrm6u0jgqnw.lambda-url.us-east-1.on.aws/?recordID=${recordID}`);
    if (!response.ok) {
        throw new Error("[getS3SignedUrls]: Network response was not ok");
    }
    const data = await response.json();
    Logger.log("[getS3SignedUrls]: Response from server:", data);
    return {
        uploadURL_html: data.uploadURL_html,
        uploadURL_markDown: data.uploadURL_markDown,
    };
}