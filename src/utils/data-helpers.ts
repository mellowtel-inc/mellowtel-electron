import { BrowserWindow } from 'electron';
import { Logger } from '../logger/logger';
import TurndownService from 'turndown';
import { Action, FormField, DataRequest } from './data-request';
import sharp from 'sharp';

const delay = (ms: number): Promise<void> => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

const createTimeoutPromise = (timeout: number, win: BrowserWindow): Promise<never> => {
    return new Promise((_, reject) => {
        setTimeout(() => {
            if (!win.isDestroyed()) {
                win.close();
            }
            reject(new Error(`Processing timed out after ${timeout} milliseconds`));
        }, timeout);
    });
};

async function takeFullPageScreenshot(win: BrowserWindow): Promise<Buffer> {
    const viewportHeight = win.getContentBounds().height;

    const screenshots: { buffer: Buffer, height: number }[] = [];
    let finalScreenshotWidth: number;

    const totalScrollableHeight = await win.webContents.executeJavaScript('document.body.scrollHeight');

    const maxScrolls = Math.min(20, Math.ceil(totalScrollableHeight / viewportHeight))

    for (let i = 0; i < maxScrolls; i++) {
        const currentScrollPosition = i * viewportHeight;
        if (currentScrollPosition >= totalScrollableHeight) {
            Logger.log('Reached the bottom of the page, stopping screenshot process.');
            break;
        }

        await win.webContents.executeJavaScript(`window.scrollTo(0, ${currentScrollPosition});`);
        await delay(1000);
        const screenshot = await win.webContents.capturePage();
        const screenshotBuffer = screenshot.toPNG();
        const { height: screenshotHeight, width: screenshotWidth } = await sharp(screenshotBuffer).metadata();
        finalScreenshotWidth = screenshotWidth!;
        screenshots.push({ buffer: screenshotBuffer, height: screenshotHeight! });
    }

    const totalHeight = screenshots.reduce((sum, screenshot) => sum + screenshot.height, 0);

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
    }))).toFormat('png', {
        compressionLevel: 9,
        quality: 40
    }).toBuffer();
}

async function executeAction(action: Action, win: BrowserWindow): Promise<void> {
    switch (action.type) {
        case "wait":
            await delay(action.milliseconds);
            break;
        case "click":
            await win.webContents.executeJavaScript(`document.querySelector("${action.selector}").click();`);
            break;
        case "write":
            await win.webContents.executeJavaScript(`
                const activeElement = document.activeElement;
                if (activeElement && "value" in activeElement) {
                    const start = activeElement.selectionStart || 0;
                    const end = activeElement.selectionEnd || 0;
                    activeElement.value = activeElement.value.substring(0, start) + "${action.text}" + activeElement.value.substring(end);
                    activeElement.selectionStart = activeElement.selectionEnd = start + "${action.text}".length;
                }
            `);
            break;
        case "fill_input":
            await win.webContents.executeJavaScript(`document.querySelector("${action.selector}").value = "${action.value}";`);
            break;
        case "fill_textarea":
            await win.webContents.executeJavaScript(`document.querySelector("${action.selector}").value = "${action.value}";`);
            break;
        case "select":
            await win.webContents.executeJavaScript(`document.querySelector("${action.selector}").value = "${action.value}";`);
            break;
        case "fill_form":
            await win.webContents.executeJavaScript(`
                const formElement = document.querySelector("${action.selector}");
                if (formElement) {
                    const formData = new FormData(formElement);
                    ${action.fields.map((field: FormField) => `formData.set("${field.name}", "${field.value}");`).join('')}
                }
            `);
            break;
        case "press":
            await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "${action.key}" }));`);
            break;
        case "scroll":
            await win.webContents.executeJavaScript(`
                window.scrollBy({
                    top: ${action.direction === "up" ? -action.amount : action.amount},
                    left: ${action.direction === "left" ? -action.amount : action.direction === "right" ? action.amount : 0},
                    behavior: "smooth",
                });
            `);
            break;
        default:
            console.warn(`Unknown action type: ${action.type}`);
    }
}

export async function processUrl(dataRequest: DataRequest): Promise<{ html: string, markdown: string, screenshot: Buffer | undefined }> {
    const timeout = 60000 + (dataRequest.waitBeforeScraping * 1000);
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            offscreen: true,
            nodeIntegration: false,
            contextIsolation: true
        },
        height: dataRequest.windowSize.height,
        width: dataRequest.windowSize.width
    });

    // Add console-message event listener
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
        Logger.log(`[Console Message] ${message} (source: ${sourceId}, line: ${line})`);
    });

    return Promise.race([
        new Promise<{ html: string, markdown: string, screenshot: Buffer | undefined }>((resolve, reject) => {

            Logger.log(`Loading url ${dataRequest.url}`);
            win.loadURL(dataRequest.url);

            win.webContents.on('dom-ready', async () => {
                Logger.log('DOM ready');
                try {
                    await delay(dataRequest.waitBeforeScraping * 1000);
                    Logger.log('Wait before processing completed');
                    if (dataRequest.removeCSSselectors) {
                        Logger.log(`Removing CSS selectors: ${dataRequest.removeCSSselectors}`);
                        
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
                            }
                            let removeCSSselectorsString = '${dataRequest.removeCSSselectors ?? 'default'}';
                            if (removeCSSselectorsString === "default") {
                                removeSelectorsFromDocument(document, [])
                            } else if (removeCSSselectorsString !== "" && removeCSSselectorsString !== "none") {
                                try {
                                    let selectors = JSON.parse(removeCSSselectorsString);
                                    removeSelectorsFromDocument(document, selectors);
                                } catch (e) {
                                    console.log("Error parsing removeCSSselectors =>", e);
                                }
                            }`;
                        await win.webContents.executeJavaScript(removeSelectorsScript);
                        Logger.log(`CSS selectors removed`);
                    }

                    if (dataRequest.actions && dataRequest.actions.length > 0) {
                        Logger.log(`Executing actions: ${JSON.stringify(dataRequest.actions)}`);
                        for (const action of dataRequest.actions) {
                            Logger.log(`Executing action: ${JSON.stringify(action)}`);
                            await executeAction(action, win);
                        }
                        Logger.log(`Actions executed`);
                    }

                    const content = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
                    Logger.log(`[processUrl]: Processed content from ${dataRequest.url}`);

                    let screenshot: Buffer | undefined;
                    if (dataRequest.htmlVisualizer) {
                        Logger.log('Taking screenshot');
                        if (dataRequest.fullpageScreenshot) {
                            Logger.log('Taking full page screenshot');
                            screenshot = await takeFullPageScreenshot(win);
                            Logger.log(`[processUrl]: Full page screenshot captured for ${dataRequest.url}`);
                        } else {
                            screenshot = (await win.webContents.capturePage()).toPNG();
                            Logger.log(`[processUrl]: Screenshot captured for ${dataRequest.url}`);
                        }
                    }

                    const turndownService = new TurndownService({
                        headingStyle: 'atx',
                        codeBlockStyle: 'fenced',
                        bulletListMarker: '*'
                    });

                    let markdown = turndownService.turndown(content);
                    Logger.log(`[processUrl]: Converted HTML to Markdown for ${dataRequest.url}`);

                    resolve({ html: content, markdown: markdown, screenshot: screenshot });
                } catch (error) {
                    Logger.error(`[processUrl]: Error processing ${dataRequest.url} - ${error}`);
                    reject(error);
                } finally {
                    if (!win.isDestroyed()) {
                        win.close();
                    }
                    Logger.log(`[processUrl]: Browser window closed for ${dataRequest.url}`);
                }
            });

            win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
                Logger.error(`[processUrl]: Error Loading to load ${dataRequest.url} - ${errorDescription}`);
                reject(new Error(errorDescription));
            });
        }),
        createTimeoutPromise(timeout, win)
    ]);
}