"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScrapeRequest = void 0;
class ScrapeRequest {
    constructor({ url, orgId, recordID, waitBeforeScraping = 0, htmlVisualizer = false, windowSize = { width: 1024, height: 1024 }, saveHtml = true, saveMarkdown = true, htmlTransformer = 'none', removeCSSselectors = '', }) {
        this.url = url;
        this.orgId = orgId;
        this.recordID = recordID;
        this.waitBeforeScraping = waitBeforeScraping;
        this.htmlVisualizer = htmlVisualizer;
        this.windowSize = windowSize;
        this.saveHtml = saveHtml;
        this.saveMarkdown = saveMarkdown;
        this.htmlTransformer = htmlTransformer;
        this.removeCSSselectors = removeCSSselectors;
    }
    // Helper function to parse size strings
    static _parseSize(size) {
        return parseFloat(size.substring(0, size.length - 2));
    }
    // Factory method to create a ScrapeRequest from a JSON object
    static fromJson(json) {
        return new ScrapeRequest({
            url: json.url,
            orgId: json.orgId,
            recordID: json.recordID,
            waitBeforeScraping: json.waitBeforeScraping,
            htmlVisualizer: json.htmlVisualizer,
            windowSize: json.screen_width && json.screen_height
                ? { width: ScrapeRequest._parseSize(json.screen_width), height: ScrapeRequest._parseSize(json.screen_height) }
                : { width: 1024, height: 1024 },
            saveHtml: json.saveHtml ?? true,
            saveMarkdown: json.saveMarkdown ?? true,
            htmlTransformer: json.htmlTransformer ?? 'none',
            removeCSSselectors: json.removeCSSselectors
        });
    }
}
exports.ScrapeRequest = ScrapeRequest;
