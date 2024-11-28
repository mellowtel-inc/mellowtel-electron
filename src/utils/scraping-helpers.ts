import { BrowserWindow, NativeImage } from 'electron';
import { Logger } from '../logger/logger';
import TurndownService from 'turndown';
import { ScrapeRequest } from './scrape-request';

const delay = (ms: number): Promise<void> => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

const createTimeoutPromise = (timeout: number, win: BrowserWindow): Promise<never> => {
    return new Promise((_, reject) => {
        setTimeout(() => {
            win.close();
            reject(new Error(`Scraping timed out after ${timeout} milliseconds`));
        }, timeout);
    });
};

export async function scrapeUrl(scrapeRequest: ScrapeRequest): Promise<{ html: string, markdown: string, screenshot: Buffer | undefined }> {
    const timeout = 45000 + (scrapeRequest.waitBeforeScraping * 1000);
    const win = new BrowserWindow({
        webPreferences: {
            nodeIntegration: true,
        },
        height: 600,
        width: 800
    });
    return Promise.race([
        new Promise<{ html: string, markdown: string, screenshot: Buffer | undefined }>((resolve, reject) => {
            
            Logger.log(`Loading url ${scrapeRequest.url}`);
            win.loadURL(scrapeRequest.url);

            win.webContents.on('dom-ready', async () => {
                Logger.log('DOM ready');
                try {
                    await delay(scrapeRequest.waitBeforeScraping * 1000);
                    Logger.log('Wait before scraping completed');

                    if (scrapeRequest.removeCSSselectors) {
                        Logger.log(`Removing CSS selectors: ${scrapeRequest.removeCSSselectors}`);
                        let removeSelectorsScript = `
                            function removeSelectorsFromDocument(document, selectorsToRemove) {
                                const defaultSelectorsToRemove = [
                                "nav", "footer", "script", "style", "noscript", "svg", '[role="alert"]', '[role="banner"]', '[role="dialog"]', '[role="alertdialog"]', '[role="region"][aria-label*="skip" i]', '[aria-modal="true"]'
                                ];
                                if (selectorsToRemove.length === 0) selectorsToRemove = defaultSelectorsToRemove;
                                selectorsToRemove.forEach((selector) => {
                                const elements = document.querySelectorAll(selector);
                                elements.forEach((element) => element.remove());
                                });
                                return 1 + 1
                            }

                            let removeCSSselectors = "${scrapeRequest.removeCSSselectors ?? 'default'}";
                            if (removeCSSselectors === "default") {
                                removeSelectorsFromDocument(document, [])
                            } else if (removeCSSselectors !== "" && removeCSSselectors !== "none") {
                                try {
                                let selectors = JSON.parse(removeCSSselectors);
                                removeSelectorsFromDocument(document, selectors);
                                } catch (e) {
                                console.log("Error parsing removeCSSselectors =>", e);
                                }
                            }`;
                        let result = await win.webContents.executeJavaScript(removeSelectorsScript);
                        Logger.log(`CSS selectors removed ${result}`);
                    }

                    const content = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
                    Logger.log(`[scrapeUrl]: Scraped content from ${scrapeRequest.url}`);

                    let screenshot: NativeImage | undefined;
                    if (scrapeRequest.htmlVisualizer) {
                        Logger.log('Taking screenshot');
                        if (scrapeRequest.fullpageScreenshot) {
                            Logger.log('Scrolling to the bottom of the page for full page screenshot');
                            await win.webContents.executeJavaScript(`
                                (function() {
                                    return new Promise((resolve) => {
                                        const scrollHeight = document.documentElement.scrollHeight;
                                        window.scrollTo(0, scrollHeight);
                                        setTimeout(() => {
                                            resolve();
                                        }, 1000); 
                                    });
                                })(); 
                            `);

                            const { width, height } = await win.webContents.executeJavaScript(`
                                ({ 
                                    width: document.documentElement.scrollWidth, 
                                    height: document.documentElement.scrollHeight 
                                })
                            `);
                            Logger.log(`Full page width: ${width} height: ${height}`);
                            win.setContentSize(width, height);
                            await delay(100); // Wait for precautionary purpose
                        }
                        screenshot = await win.webContents.capturePage();
                        Logger.log(`[scrapeUrl]: Screenshot captured for ${scrapeRequest.url}`);
                    }

                    // Initialize TurndownService
                    const turndownService = new TurndownService({
                        headingStyle: 'atx',
                        codeBlockStyle: 'fenced',
                        bulletListMarker: '*'
                    });

                    // Convert HTML to Markdown
                    let markdown = turndownService.turndown(content);
                    Logger.log(`===Markdown: ${markdown}`)
                    Logger.log(`[scrapeUrl]: Converted HTML to Markdown for ${scrapeRequest.url}`);

                    resolve({ html: content, markdown: markdown, screenshot: screenshot?.toPNG() });
                } catch (error) {
                    Logger.error(`[scrapeUrl]: Error scraping ${scrapeRequest.url} - ${error}`);
                    reject(error);
                } finally {
                    if(!win.isDestroyed){
                        win.close();
                    }
                    Logger.log(`[scrapeUrl]: Browser window closed for ${scrapeRequest.url}`);
                }
            });

            win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
                Logger.error(`[scrapeUrl]: Error Loading to load ${scrapeRequest.url} - ${errorDescription}`);
                reject(new Error(errorDescription));
            });
        }),
        createTimeoutPromise(timeout, win)
    ]);
}
export async function getS3SignedUrls(recordID: string): Promise<{ uploadURL_html: string; uploadURL_markDown: string; uploadURL_htmlVisualizer: string }> {
    const response = await fetch(`https://5xub3rkd3rqg6ebumgrvkjrm6u0jgqnw.lambda-url.us-east-1.on.aws/?recordID=${recordID}`);
    if (!response.ok) {
        throw new Error("[getS3SignedUrls]: Network response was not ok");
    }
    const data = await response.json();
    Logger.log("[getS3SignedUrls]: Response from server:", data);
    return {
        uploadURL_html: data.uploadURL_html,
        uploadURL_markDown: data.uploadURL_markDown,
        uploadURL_htmlVisualizer: data.uploadURL_htmlVisualizer
    };
}

