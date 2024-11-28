import { BrowserWindow } from 'electron';
import { Logger } from '../logger/logger';
import TurndownService from 'turndown';
import { ScrapeRequest } from './scrape-request';
import sharp from 'sharp';

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

async function takeFullPageScreenshot(win: BrowserWindow): Promise<Buffer> {
    const viewportHeight = win.getContentBounds().height;
    console.log("Viewport Height", viewportHeight);
    // const maxScrolls = 20;
    const screenshots: { buffer: Buffer, height: number }[] = [];
    let finalScreenshotWidth: number;

    // Calculate the total scrollable height of the page
    const totalScrollableHeight = await win.webContents.executeJavaScript('document.body.scrollHeight');
    console.log("Total Scrollable Height", totalScrollableHeight);

    //TODO:
    const maxScrolls = Math.min(20, Math.ceil(totalScrollableHeight / viewportHeight))

    for (let i = 0; i < maxScrolls; i++) {
        const currentScrollPosition = i * viewportHeight;
        if (currentScrollPosition >= totalScrollableHeight) {
            console.log('Reached the bottom of the page, stopping screenshot process.');
            break;
        }

        await win.webContents.executeJavaScript(`window.scrollTo(0, ${currentScrollPosition});`);
        await delay(1000); 
        const screenshot = await win.webContents.capturePage();
        const screenshotBuffer = screenshot.toPNG();
        const { height: screenshotHeight, width: screenshotWidth } = await sharp(screenshotBuffer).metadata();
        finalScreenshotWidth = screenshotWidth!;
        console.log(`Screenshot Height ${screenshotHeight} ${screenshotWidth}`);
        screenshots.push({ buffer: screenshotBuffer, height: screenshotHeight! });
    }

    const totalHeight = screenshots.reduce((sum, screenshot) => sum + screenshot.height, 0);
    console.log('total height: ', totalHeight);

    return await sharp({
        create: {
            width: finalScreenshotWidth!,
            height: totalHeight,
            channels: 3,
            background: { r: 255, g: 255, b: 255 }
        }
    }).composite(screenshots.map((img, index) => ({
            input: img.buffer,
            top: index * screenshots[0].height,
            left: 0
        }))).toFormat('png').toBuffer();
}

export async function scrapeUrl(scrapeRequest: ScrapeRequest): Promise<{ html: string, markdown: string, screenshot: Buffer | undefined }> {
    const timeout = 50000 + (scrapeRequest.waitBeforeScraping * 1000);
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            offscreen: true,
            nodeIntegration: false,
            contextIsolation: true
        },
        height: scrapeRequest.windowSize.height,
        width: scrapeRequest.windowSize.width
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

                    let screenshot: Buffer | undefined;
                    if (scrapeRequest.htmlVisualizer) {
                        Logger.log('Taking screenshot');
                        if (scrapeRequest.fullpageScreenshot) {
                            Logger.log('Taking full page screenshot');
                            screenshot = await takeFullPageScreenshot(win);
                            Logger.log(`[scrapeUrl]: Full page screenshot captured for ${scrapeRequest.url}`);
                        } else {
                            screenshot = (await win.webContents.capturePage()).toPNG();
                            Logger.log(`[scrapeUrl]: Screenshot captured for ${scrapeRequest.url}`);
                        }
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

                    resolve({ html: content, markdown: markdown, screenshot: screenshot });
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