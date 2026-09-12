import { BrowserWindow } from 'electron';
import { Logger } from '../logger/logger';
import { ObservedError } from '../observability/observed-error';
import { currentJobTrace } from '../observability/trace';
import TurndownService from 'turndown';
import { DataRequest } from './data-request';
import { runActions } from './actions';
import { getWindowPool, windowPoolConfigFor } from './window-pool';
import { executeWithJarWindow, parseJobOrigin, resetJarAll, resetJarOrigin, restoreCookies, snapshotCookies } from './jar';
import { applyJobClient, buildStealthScript, releaseJobClient } from './client';
import sharp from 'sharp';

export async function makeFetchRequest(dataRequest: DataRequest): Promise<{ contentType: string | null, content: Buffer }> {
    const { method_endpoint, method, method_payload, method_headers } = dataRequest;

    const options: RequestInit = {
        method: method,
        headers: method_headers
    };

    if (method_payload && method_payload !== 'no_payload') {
        options.body = method_payload;
    }

    try {
        const response = await fetch(method_endpoint, options);
        const contentType = response.headers.get('content-type');
        const content = await response.arrayBuffer();
        currentJobTrace()?.add('info', `[makeFetchRequest] ${response.status} ${method_endpoint}`, {
            status: response.status,
            statusText: response.statusText,
            contentType,
            bytes: content.byteLength,
        });
        if (!response.ok) {
            const bodyPreview = Buffer.from(content).toString('utf-8').slice(0, 2000);
            throw new ObservedError(`[makeFetchRequest] HTTP ${response.status} for ${method_endpoint}`, {
                code: 'FETCH_FAILED',
                stage: 'fetch',
                raw: {
                    method,
                    method_endpoint,
                    status: response.status,
                    statusText: response.statusText,
                    body: bodyPreview,
                },
            });
        }
        return { contentType, content: Buffer.from(content) };
    } catch (error) {
        Logger.error(`[makeFetchRequest]: Error fetching ${method_endpoint} - ${error}`);
        if (error instanceof ObservedError) {
            throw error;
        }
        throw new ObservedError(`[makeFetchRequest]: Error fetching ${method_endpoint} - ${error}`, {
            code: 'FETCH_FAILED',
            stage: 'fetch',
            raw: { method, method_endpoint, error: String(error) },
            cause: error,
        });
    }
}

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

async function runRequestActions(win: BrowserWindow, dataRequest: DataRequest): Promise<void> {
    if (!dataRequest.actions || dataRequest.actions.length === 0) {
        return;
    }
    Logger.log(`[actions]: running ${dataRequest.actions.length} step(s)`);
    dataRequest.actionResults = await runActions(win, dataRequest.actions, dataRequest.actionSettings());
}

export async function processHtmlContent(htmlString: string, dataRequest: DataRequest): Promise<{ html: string; markdown: string; screenshot: Buffer | undefined; contentType: string | undefined }> {
    const windowPool = getWindowPool(windowPoolConfigFor(dataRequest));
    
    return windowPool.executeWithWindow(async (win: BrowserWindow) => {
        applyJobClient(win, dataRequest.client);
        // Create a 60-second timeout promise
        let timeoutId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new ObservedError(`[processHtmlContent] Timeout: HTML processing exceeded 60 seconds`, {
                    code: 'HTML_PROCESS_TIMEOUT',
                    stage: 'process_html',
                    raw: { timeout_ms: 60000 },
                }));
            }, 60000);
        });

        // Race between the actual processing and the timeout
        try {
            return await Promise.race([
            (async () => {
                // Resize window if needed
                if (dataRequest.windowSize.width || dataRequest.windowSize.height) {
                    win.setSize(
                        dataRequest.windowSize.width || 1709,
                        dataRequest.windowSize.height || 984
                    );
                }

                try {
            // Load the HTML content directly and wait for it to load
            await new Promise<void>((resolve, reject) => {
                win.webContents.on('dom-ready', () => {
                    resolve();
                });
                win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
                    reject(new Error(`Failed to load HTML: ${errorDescription}`));
                });
                win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlString)}`);
            });

            // Wait if specified
            if (dataRequest.waitBeforeScraping > 0) {
                Logger.log(`[processHtmlContent]: Waiting ${dataRequest.waitBeforeScraping} seconds before processing`);
                await delay(dataRequest.waitBeforeScraping * 1000);
            }

            // Remove CSS selectors if specified
            if (dataRequest.removeCSSselectors) {
                Logger.log(`[processHtmlContent]: Removing CSS selectors: ${dataRequest.removeCSSselectors}`);

                const removeSelectorsScript = `
                    function removeSelectorsFromDocument(document, selectorsToRemove) {
                        const defaultSelectorsToRemove = [
                            "nav", "footer", "script", "style", "noscript", "svg", 
                            '[role="alert"]', '[role="banner"]', '[role="dialog"]', 
                            '[role="alertdialog"]', '[role="region"][aria-label*="skip" i]', 
                            '[aria-modal="true"]'
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
                    }
                `;
                await win.webContents.executeJavaScript(removeSelectorsScript);
                Logger.log(`[processHtmlContent]: CSS selectors removed`);
            }

            await runRequestActions(win, dataRequest);

            // Get the processed HTML content
            const content = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
            Logger.log(`[processHtmlContent]: Processed HTML content`);

            // Handle screenshots if requested
            let screenshot: Buffer | undefined;
            if (dataRequest.htmlVisualizer) {
                Logger.log('[processHtmlContent]: Taking screenshot');
                if (dataRequest.fullpageScreenshot) {
                    Logger.log('[processHtmlContent]: Taking full page screenshot');
                    screenshot = await takeFullPageScreenshot(win);
                    Logger.log(`[processHtmlContent]: Full page screenshot captured`);
                } else {
                    screenshot = (await win.webContents.capturePage()).toPNG();
                    Logger.log(`[processHtmlContent]: Screenshot captured`);
                }
            }

            // Convert to markdown
            const turndownService = new TurndownService({
                headingStyle: 'atx',
                codeBlockStyle: 'fenced',
                bulletListMarker: '*'
            });

            let markdown = turndownService.turndown(content);
            Logger.log(`[processHtmlContent]: Converted HTML to Markdown`);

                    return {
                        html: content,
                        markdown: markdown,
                        screenshot: screenshot,
                        contentType: screenshot ? 'image/png' : undefined
                    };
                } catch (error) {
                    Logger.error(`[processHtmlContent]: Error processing HTML content - ${error}`);
                    // Return original content on error
                    return {
                        html: htmlString,
                        markdown: htmlString,
                        screenshot: undefined,
                        contentType: undefined
                    };
                }
            })(),
                timeoutPromise
            ]);
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            releaseJobClient(win);
        }
    });
}

async function applyJarReset(dataRequest: DataRequest): Promise<void> {
    if (dataRequest.resetJar === 'none') {
        return;
    }
    if (dataRequest.resetJar === 'all') {
        await resetJarAll();
        return;
    }
    await resetJarOrigin(parseJobOrigin(dataRequest.url));
}

export async function processUrl(dataRequest: DataRequest): Promise<{ html: string, markdown: string, screenshot: Buffer | undefined, contentType: string | undefined }> {
    await applyJarReset(dataRequest);

    const run = (win: BrowserWindow) => processUrlWithWindow(win, dataRequest);

    if (dataRequest.jar === 'empty') {
        const windowPool = getWindowPool(windowPoolConfigFor(dataRequest));
        return windowPool.executeWithWindow(run);
    }

    const origin = parseJobOrigin(dataRequest.url);
    return executeWithJarWindow(origin, async (win: BrowserWindow) => {
        const snapshot = dataRequest.jar === 'reuse' ? await snapshotCookies(origin) : undefined;
        try {
            return await run(win);
        } finally {
            if (dataRequest.jar === 'reuse' && snapshot) {
                try {
                    await restoreCookies(origin, snapshot);
                } catch (error) {
                    Logger.error(`[processUrl]: Failed to restore jar cookies for ${origin}: ${error}`);
                }
            }
        }
    });
}

async function processUrlWithWindow(win: BrowserWindow, dataRequest: DataRequest): Promise<{ html: string, markdown: string, screenshot: Buffer | undefined, contentType: string | undefined }> {
        // Create a 60-second timeout promise
        let timeoutId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new ObservedError(`[processUrl] Timeout: URL processing exceeded 60 seconds for ${dataRequest.url}`, {
                    code: 'SCRAPE_TIMEOUT',
                    stage: 'scrape',
                    raw: { timeout_ms: 60000, url: dataRequest.url },
                }));
            }, 60000);
        });

        const client = applyJobClient(win, dataRequest.client);

        // Race between the actual processing and the timeout
        try {
            return await Promise.race([
            (async () => {
                // Resize window if needed
                if (dataRequest.windowSize.width || dataRequest.windowSize.height) {
                    win.setSize(
                        dataRequest.windowSize.width || 1709,
                        dataRequest.windowSize.height || 984
                    );
                }

                try {
            const stealthScript = buildStealthScript(client);

            // Load the URL and wait for it to load
            await new Promise<void>((resolve, reject) => {
                const domReadyHandler = async () => {
                    try {
                        // Inject stealth script after DOM is ready
                        await win.webContents.executeJavaScript(stealthScript);
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                };

                const failLoadHandler = (_event: any, errorCode: number, errorDescription: string) => {
                    reject(new ObservedError(`Failed to load URL: ${errorDescription}`, {
                        code: 'NAVIGATION_FAILED',
                        stage: 'scrape',
                        raw: { errorCode, errorDescription, url: dataRequest.url },
                    }));
                };

                win.webContents.once('dom-ready', domReadyHandler);
                win.webContents.once('did-fail-load', failLoadHandler);

                Logger.log(`[processUrl]: Loading url ${dataRequest.url}`);
                win.loadURL(dataRequest.url);
            });

            Logger.log('[processUrl]: DOM ready');

            // Wait if specified
            if (dataRequest.waitBeforeScraping > 0) {
                Logger.log(`[processUrl]: Waiting ${dataRequest.waitBeforeScraping} seconds before processing`);
                await delay(dataRequest.waitBeforeScraping * 1000);
            }

            // Remove CSS selectors if specified
            if (dataRequest.removeCSSselectors) {
                Logger.log(`[processUrl]: Removing CSS selectors: ${dataRequest.removeCSSselectors}`);

                const removeSelectorsScript = `
                    function removeSelectorsFromDocument(document, selectorsToRemove) {
                        const defaultSelectorsToRemove = [
                            "nav", "footer", "script", "style", "noscript", "svg", 
                            '[role="alert"]', '[role="banner"]', '[role="dialog"]', 
                            '[role="alertdialog"]', '[role="region"][aria-label*="skip" i]', 
                            '[aria-modal="true"]'
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
                    }
                `;
                await win.webContents.executeJavaScript(removeSelectorsScript);
                Logger.log(`[processUrl]: CSS selectors removed`);
            }

            await runRequestActions(win, dataRequest);

            // Get the processed HTML content
            const content = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
            Logger.log(`[processUrl]: Processed content from ${dataRequest.url}`);

            // Handle screenshots if requested
            let screenshot: Buffer | undefined;
            if (dataRequest.htmlVisualizer) {
                Logger.log('[processUrl]: Taking screenshot');
                if (dataRequest.fullpageScreenshot) {
                    Logger.log('[processUrl]: Taking full page screenshot');
                    screenshot = await takeFullPageScreenshot(win);
                    Logger.log(`[processUrl]: Full page screenshot captured for ${dataRequest.url}`);
                } else {
                    screenshot = (await win.webContents.capturePage()).toPNG();
                    Logger.log(`[processUrl]: Screenshot captured for ${dataRequest.url}`);
                }
            }

            // Convert to markdown
            const turndownService = new TurndownService({
                headingStyle: 'atx',
                codeBlockStyle: 'fenced',
                bulletListMarker: '*'
            });

            let markdown = turndownService.turndown(content);
            Logger.log(`[processUrl]: Converted HTML to Markdown for ${dataRequest.url}`);

                    return {
                        html: content,
                        markdown: markdown,
                        screenshot: screenshot,
                        contentType: screenshot ? 'image/png' : undefined
                    };
                } catch (error) {
                    Logger.error(`[processUrl]: Error processing ${dataRequest.url} - ${error}`);
                    throw error;
                }
            })(),
                timeoutPromise
            ]);
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            releaseJobClient(win);
        }
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
