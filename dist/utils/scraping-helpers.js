"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scrapeUrl = scrapeUrl;
exports.getS3SignedUrls = getS3SignedUrls;
const electron_1 = require("electron");
const logger_1 = require("../logger/logger");
const turndown_1 = __importDefault(require("turndown"));
const delay = (ms) => {
    return new Promise(resolve => setTimeout(resolve, ms));
};
async function scrapeUrl(scrapeRequest) {
    return new Promise((resolve, reject) => {
        const win = new electron_1.BrowserWindow({
            show: false,
            webPreferences: {
                offscreen: true,
                nodeIntegration: false,
                contextIsolation: true,
            },
            height: scrapeRequest.windowSize.height,
            width: scrapeRequest.windowSize.width
        });
        win.loadURL(scrapeRequest.url);
        win.webContents.on('did-finish-load', async () => {
            try {
                await delay(scrapeRequest.waitBeforeScraping * 1000);
                if (scrapeRequest.removeCSSselectors) {
                    let removeSelectorsScript = `
                    (function() {
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
              
                      let removeCSSselectors = ${scrapeRequest.removeCSSselectors == "default" ? "[]" : scrapeRequest.removeCSSselectors};
                      if (removeCSSselectors === "default") {
                        removeSelectorsFromDocument(document, []);
                      } else if (removeCSSselectors !== "" && removeCSSselectors !== "none") {
                        try {
                          let selectors = JSON.parse(removeCSSselectors);
                          removeSelectorsFromDocument(document, selectors);
                        } catch (e) {
                          console.log("Error parsing removeCSSselectors =>", e);
                        }
                      }
                    })();
                  `;
                    await win.webContents.executeJavaScript(removeSelectorsScript);
                }
                const content = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
                logger_1.Logger.log(`[scrapeUrl]: Scraped content from ${scrapeRequest.url}`);
                let screenshot;
                if (scrapeRequest.htmlVisualizer) {
                    screenshot = await win.webContents.capturePage();
                    logger_1.Logger.log(`[scrapeUrl]: Screenshot captured for ${scrapeRequest.url}`);
                }
                // Initialize TurndownService
                const turndownService = new turndown_1.default({
                    headingStyle: 'atx',
                    codeBlockStyle: 'fenced',
                    bulletListMarker: '*'
                });
                // Convert HTML to Markdown
                let markdown = turndownService.turndown(content);
                resolve({ html: content, markdown: markdown, screenshot: screenshot?.toPNG() });
            }
            catch (error) {
                logger_1.Logger.error(`[scrapeUrl]: Error scraping ${scrapeRequest.url} - ${error}`);
                reject(error);
            }
            finally {
                win.close();
            }
        });
        win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
            logger_1.Logger.error(`[scrapeUrl]: Failed to load ${scrapeRequest.url} - ${errorDescription}`);
            reject(new Error(errorDescription));
            win.close();
        });
    });
}
async function getS3SignedUrls(recordID) {
    const response = await fetch(`https://5xub3rkd3rqg6ebumgrvkjrm6u0jgqnw.lambda-url.us-east-1.on.aws/?recordID=${recordID}`);
    if (!response.ok) {
        throw new Error("[getS3SignedUrls]: Network response was not ok");
    }
    const data = await response.json();
    logger_1.Logger.log("[getS3SignedUrls]: Response from server:", data);
    return {
        uploadURL_html: data.uploadURL_html,
        uploadURL_markDown: data.uploadURL_markDown,
        uploadURL_htmlVisualizer: data.uploadURL_htmlVisualizer
    };
}
