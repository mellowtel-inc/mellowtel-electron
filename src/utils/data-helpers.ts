import { BrowserWindow, session } from 'electron';
import { Logger } from '../logger/logger';
import TurndownService from 'turndown';
import { Action, FormField, DataRequest } from './data-request';
import sharp from 'sharp';
import * as os from 'os';

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
    
    // Create a unique session for each window to avoid tracking
    const uniqueSession = session.fromPartition(`persist:window-${Date.now()}-${Math.random()}`);
    
    // Create the browser window with stealth features
    const win = new BrowserWindow({
        show: false,
        width: dataRequest.windowSize.width || 1709,
        height: dataRequest.windowSize.height || 984,
        webPreferences: {
            offscreen: true,
            nodeIntegration: false,
            contextIsolation: true,
            session: uniqueSession,
            webSecurity: true,
            allowRunningInsecureContent: false,
            experimentalFeatures: false
        }
    });

    // Set OS-specific user agent to mimic a normal browser
    const platform = os.platform();
    const userAgent = platform === 'win32' 
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36'
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';
    
    win.webContents.setUserAgent(userAgent);
    
    // Set comprehensive browser headers to match real Chrome requests
    uniqueSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = {
            ...details.requestHeaders,
            'Referer': 'https://www.google.com/',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="139", "Google Chrome";v="139"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': platform === 'win32' ? '"Windows"' : '"macOS"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'cross-site',
            'sec-fetch-user': '?1',
            'upgrade-insecure-requests': '1',
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'accept-language': 'en-US,en;q=0.9',
            'accept-encoding': 'gzip, deflate, br, zstd',
            'cache-control': 'max-age=0'
        };
        
        callback({ requestHeaders: headers });
    });

    // Add console-message event listener
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
        Logger.log(`[Console Message] ${message} (source: ${sourceId}, line: ${line})`);
    });

    // Add stealth features to avoid bot detection
    win.webContents.once('did-finish-load', () => {
        win.webContents.executeJavaScript(`
            // Override webdriver property
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
            
            // Override chrome property to match real Chrome
            Object.defineProperty(window, 'chrome', {
                writable: true,
                enumerable: true,
                configurable: false,
                value: {
                    runtime: {
                        onConnect: undefined,
                        onMessage: undefined,
                    },
                },
            });
            
            // Override permissions API to match browser behavior
            const originalQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (parameters) => (
                parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
            );
            
            // Add realistic screen and viewport properties
            Object.defineProperty(window.screen, 'availTop', { value: 23 });
            Object.defineProperty(window.screen, 'availLeft', { value: 0 });
            
            // Simulate human-like mouse movement
            let mouseX = Math.floor(Math.random() * window.innerWidth);
            let mouseY = Math.floor(Math.random() * window.innerHeight);
            
            const mouseInterval = setInterval(() => {
                mouseX += (Math.random() - 0.5) * 3;
                mouseY += (Math.random() - 0.5) * 3;
                mouseX = Math.max(0, Math.min(window.innerWidth, mouseX));
                mouseY = Math.max(0, Math.min(window.innerHeight, mouseY));
                
                document.dispatchEvent(new MouseEvent('mousemove', {
                    clientX: mouseX,
                    clientY: mouseY,
                    bubbles: true
                }));
            }, 100 + Math.random() * 200);
            
            // Add realistic timing variations
            const originalSetTimeout = window.setTimeout;
            window.setTimeout = function(callback, delay, ...args) {
                const variation = Math.random() * 10 - 5; // ±5ms variation
                return originalSetTimeout(callback, delay + variation, ...args);
            };
            
            // Clean up interval when page unloads
            window.addEventListener('beforeunload', () => {
                clearInterval(mouseInterval);
            });
        `);
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

export async function cerealMain(
    cerealObject: string,
    recordID: string,
    content: string,
): Promise<any> {
    const win = new BrowserWindow({
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
        Logger.log(`[Cereal Window Console] ${message} (source: ${sourceId}, line: ${line})`);
    });

    const mainWork = new Promise((resolve, reject) => {
        const responseListener = (event: any, level: number, message: string) => {
            const prefix = 'CEREAL_RESPONSE::';
            Logger.log(`[Cereal RESPONSE] ${message})`);
            if (message.startsWith(prefix)) {
                try {
                    const response = JSON.parse(message.substring(prefix.length));
                    if (response.recordID === recordID) {
                        Logger.log("[cerealMain]: Received cerealResult:", response.json);
                        win.webContents.removeListener('console-message', responseListener);
                        resolve(response.json);
                    }
                } catch (e) {
                    Logger.error(`[cerealMain]: Error parsing cereal response - ${e}`);
                }
            }
        };
        win.webContents.on('console-message', responseListener);

        win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            reject(new Error(`Failed to load cereal page: ${errorDescription}`));
        });

        win.webContents.on('did-finish-load', async () => {
            try {
                const message = {
                    type: "PROCESS_DOCUMENT",
                    recordID: recordID,
                    htmlString: content,
                    cerealObject:
                        typeof cerealObject === "string"
                            ? cerealObject
                            : JSON.stringify(cerealObject),
                };

                await win.webContents.executeJavaScript(
                    `
                    (() => {
                        const message = ${JSON.stringify(message)};
                        const listener = (event) => {
                            if (event.data?.type === 'CEREAL_RESPONSE' && event.data?.recordID === message.recordID) {
                                console.log('CEREAL_RESPONSE::' + JSON.stringify(event.data));
                                window.removeEventListener('message', listener);
                            }
                        };
                        window.addEventListener('message', listener);
                        window.postMessage(message, '*');
                    })()
                    `
                );
            } catch (e) {
                reject(e);
            }
        });

        win.loadURL("https://www.mellowtel.com/cereal");
    });

    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error("Cereal process timed out after 30 seconds."));
        }, 30000);
    });

    try {
        return await Promise.race([mainWork, timeoutPromise]);
    } finally {
        if (!win.isDestroyed()) {
            win.close();
        }
    }
}
