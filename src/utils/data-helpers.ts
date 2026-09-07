import { BrowserWindow, session } from 'electron';
import { Logger } from '../logger/logger';
import TurndownService from 'turndown';
import { Action, FormField, DataRequest } from './data-request';
import { getWindowPool, windowPoolConfigFor } from './window-pool';
import sharp from 'sharp';
import * as os from 'os';

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
        return { contentType, content: Buffer.from(content) };
    } catch (error) {
        Logger.error(`[makeFetchRequest]: Error fetching ${method_endpoint} - ${error}`);
        throw error;
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
            Logger.log(`[executeAction]: Unknown action type: ${action.type}`);
    }
}

export async function processHtmlContent(htmlString: string, dataRequest: DataRequest): Promise<{ html: string; markdown: string; screenshot: Buffer | undefined; contentType: string | undefined }> {
    const windowPool = getWindowPool(windowPoolConfigFor(dataRequest));
    
    return windowPool.executeWithWindow(async (win: BrowserWindow) => {
        // Create a 60-second timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`[processHtmlContent] Timeout: HTML processing exceeded 60 seconds`));
            }, 60000);
        });

        // Race between the actual processing and the timeout
        return Promise.race([
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

            // Execute actions if specified
            if (dataRequest.actions && dataRequest.actions.length > 0) {
                Logger.log(`[processHtmlContent]: Executing ${dataRequest.actions.length} actions`);
                for (const action of dataRequest.actions) {
                    Logger.log(`[processHtmlContent]: Executing action: ${JSON.stringify(action)}`);
                    await executeAction(action, win);
                }
                Logger.log(`[processHtmlContent]: Actions executed`);
            }

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
    });
}

export async function processUrl(dataRequest: DataRequest): Promise<{ html: string, markdown: string, screenshot: Buffer | undefined, contentType: string | undefined }> {
    const windowPool = getWindowPool(windowPoolConfigFor(dataRequest));
    
    return windowPool.executeWithWindow(async (win: BrowserWindow) => {
        // Create a 60-second timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new Error(`[processUrl] Timeout: URL processing exceeded 60 seconds for ${dataRequest.url}`));
            }, 60000);
        });

        // Race between the actual processing and the timeout
        return Promise.race([
            (async () => {
                // Resize window if needed
                if (dataRequest.windowSize.width || dataRequest.windowSize.height) {
                    win.setSize(
                        dataRequest.windowSize.width || 1709,
                        dataRequest.windowSize.height || 984
                    );
                }

                // Note: User agent and session headers are already configured in the window pool
                // This prevents accumulating event listeners on every request

                try {
            // Add stealth features to avoid bot detection and block UI dialogs
            const stealthScript = `
                (function() {
                    'use strict';

                    // === DIALOG BLOCKING ===
                    window.alert = function() { return undefined; };
                    window.confirm = function() { return false; };
                    window.prompt = function() { return null; };
                    window.print = function() { return undefined; };

                    // === DETECTION BYPASS ===

                    // 1. Webdriver
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    try { delete navigator.__proto__.webdriver; } catch(e) {}

                    // 2. Chrome object
                    Object.defineProperty(window, 'chrome', {
                        writable: true,
                        enumerable: true,
                        configurable: false,
                        value: {
                            runtime: {
                                onConnect: undefined,
                                onMessage: undefined,
                                connect: function() {},
                                sendMessage: function() {},
                            },
                            loadTimes: function() { return {}; },
                            csi: function() { return {}; },
                        },
                    });

                    // 3. Plugins array
                    const makePluginArray = () => {
                        const plugins = [
                            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
                        ];
                        const arr = Object.create(PluginArray.prototype);
                        plugins.forEach((p, i) => {
                            const plugin = Object.create(Plugin.prototype);
                            Object.defineProperties(plugin, {
                                name: { value: p.name, enumerable: true },
                                filename: { value: p.filename, enumerable: true },
                                description: { value: p.description, enumerable: true },
                                length: { value: 0, enumerable: true },
                            });
                            arr[i] = plugin;
                        });
                        Object.defineProperties(arr, {
                            length: { value: plugins.length, enumerable: true },
                            item: { value: (i) => arr[i] || null },
                            namedItem: { value: (n) => plugins.find(p => p.name === n) || null },
                            refresh: { value: () => {} },
                        });
                        return arr;
                    };
                    Object.defineProperty(navigator, 'plugins', { get: makePluginArray });

                    // 4. Languages
                    Object.defineProperty(navigator, 'languages', {
                        get: () => Object.freeze(['en-US', 'en'])
                    });

                    // 5. Dimensions fix for offscreen rendering
                    if (window.outerWidth === 0) {
                        Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
                    }
                    if (window.outerHeight === 0) {
                        Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
                    }

                    // 6. WebGL fingerprint
                    const hookWebGL = (proto) => {
                        const original = proto.getParameter;
                        proto.getParameter = function(param) {
                            if (param === 37445) return 'Google Inc. (Intel)';
                            if (param === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)';
                            return original.call(this, param);
                        };
                    };
                    hookWebGL(WebGLRenderingContext.prototype);
                    if (typeof WebGL2RenderingContext !== 'undefined') {
                        hookWebGL(WebGL2RenderingContext.prototype);
                    }

                    // 7. Permissions API
                    if (navigator.permissions) {
                        const orig = navigator.permissions.query.bind(navigator.permissions);
                        navigator.permissions.query = (params) => {
                            if (params.name === 'notifications') {
                                return Promise.resolve({ state: 'prompt', onchange: null });
                            }
                            return orig(params).catch(() => ({ state: 'prompt', onchange: null }));
                        };
                    }

                    // 8. Screen properties
                    Object.defineProperty(screen, 'availTop', { value: 0 });
                    Object.defineProperty(screen, 'availLeft', { value: 0 });
                    Object.defineProperty(screen, 'colorDepth', { value: 24 });
                    Object.defineProperty(screen, 'pixelDepth', { value: 24 });

                    // 9. Connection type
                    if (navigator.connection) {
                        Object.defineProperty(navigator.connection, 'rtt', { value: 50 });
                    }

                    // 10. Hardware concurrency
                    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8 });

                    // 11. Device memory
                    Object.defineProperty(navigator, 'deviceMemory', { value: 8 });

                    // === HUMAN SIMULATION ===

                    // Mouse movement
                    let mouseX = Math.floor(Math.random() * window.innerWidth);
                    let mouseY = Math.floor(Math.random() * window.innerHeight);
                    const mouseInterval = setInterval(() => {
                        mouseX += (Math.random() - 0.5) * 5;
                        mouseY += (Math.random() - 0.5) * 5;
                        mouseX = Math.max(0, Math.min(window.innerWidth, mouseX));
                        mouseY = Math.max(0, Math.min(window.innerHeight, mouseY));
                        document.dispatchEvent(new MouseEvent('mousemove', {
                            clientX: mouseX, clientY: mouseY, bubbles: true
                        }));
                    }, 100 + Math.random() * 200);

                    // Timing variation
                    const origTimeout = window.setTimeout;
                    window.setTimeout = function(fn, delay, ...args) {
                        return origTimeout(fn, Math.max(0, (delay || 0) + (Math.random() * 10 - 5)), ...args);
                    };

                    window.addEventListener('beforeunload', () => clearInterval(mouseInterval));

                    // === BLOCK UI-TRIGGERING APIS ===

                    window.Notification = function() { throw new Error('Disabled'); };
                    window.Notification.permission = 'denied';
                    window.Notification.requestPermission = () => Promise.resolve('denied');

                    window.PaymentRequest = undefined;
                    window.showOpenFilePicker = undefined;
                    window.showSaveFilePicker = undefined;
                    window.showDirectoryPicker = undefined;

                    navigator.share = undefined;
                    navigator.canShare = () => false;

                    if (navigator.credentials) {
                        navigator.credentials.get = () => Promise.reject(new Error('Disabled'));
                        navigator.credentials.store = () => Promise.reject(new Error('Disabled'));
                        navigator.credentials.create = () => Promise.reject(new Error('Disabled'));
                    }

                    Element.prototype.requestFullscreen = () => Promise.reject(new Error('Disabled'));
                    if (Element.prototype.webkitRequestFullscreen) {
                        Element.prototype.webkitRequestFullscreen = function() {};
                    }

                    // Block file input clicks
                    const originalClick = HTMLInputElement.prototype.click;
                    HTMLInputElement.prototype.click = function() {
                        if (this.type === 'file') return;
                        return originalClick.call(this);
                    };

                    // Block keyboard shortcuts that trigger dialogs
                    document.addEventListener('keydown', function(e) {
                        if (e.ctrlKey || e.metaKey) {
                            if (['p', 's', 'f', 'o', 'n'].includes(e.key.toLowerCase())) {
                                e.preventDefault();
                                e.stopPropagation();
                                return false;
                            }
                        }
                    }, true);

                })();
            `;

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

                const failLoadHandler = (event: any, errorCode: number, errorDescription: string) => {
                    reject(new Error(`Failed to load URL: ${errorDescription}`));
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

            // Execute actions if specified
            if (dataRequest.actions && dataRequest.actions.length > 0) {
                Logger.log(`[processUrl]: Executing ${dataRequest.actions.length} actions`);
                for (const action of dataRequest.actions) {
                    Logger.log(`[processUrl]: Executing action: ${JSON.stringify(action)}`);
                    await executeAction(action, win);
                }
                Logger.log(`[processUrl]: Actions executed`);
            }

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
    });
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
