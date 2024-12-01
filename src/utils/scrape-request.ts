interface Size {
    width: number;
    height: number;
}

export interface FormField {
    name: string;
    value: string;
}

export interface Action {
    type: string;
    [key: string]: any;
}

interface ScrapeRequestParams {
    url: string;
    orgId: string;
    recordID: string;
    waitBeforeScraping?: number;
    htmlVisualizer?: boolean;
    windowSize?: Size;
    saveHtml?: boolean;
    saveMarkdown?: boolean;
    htmlTransformer?: string;
    fullpageScreenshot?: boolean;
    removeCSSselectors?: string;
    actions?: Action[]; // Add actions as an optional property
}

export class ScrapeRequest {
    url: string;
    orgId: string;
    recordID: string;
    waitBeforeScraping: number;
    htmlVisualizer?: boolean;
    windowSize: Size;
    saveHtml: boolean;
    saveMarkdown: boolean;
    htmlTransformer: string;
    removeCSSselectors?: string;
    fullpageScreenshot?: boolean;
    actions?: Action[]; // Add actions as an optional property

    constructor({
        url,
        orgId,
        recordID,
        waitBeforeScraping = 0,
        htmlVisualizer = false,
        windowSize = { width: 1024, height: 1024 },
        saveHtml = true,
        saveMarkdown = true,
        htmlTransformer = 'none',
        fullpageScreenshot = false,
        removeCSSselectors = '',
        actions = []
    }: ScrapeRequestParams) {
        this.url = url;
        this.orgId = orgId;
        this.recordID = recordID;
        this.waitBeforeScraping = waitBeforeScraping;
        this.htmlVisualizer = htmlVisualizer;
        this.windowSize = windowSize;
        this.saveHtml = saveHtml;
        this.saveMarkdown = saveMarkdown;
        this.htmlTransformer = htmlTransformer;
        this.fullpageScreenshot = fullpageScreenshot;
        this.removeCSSselectors = removeCSSselectors;
        this.actions = actions;
    }

    // Helper function to parse size strings
    static _parseSize(size: string): number {
        return parseFloat(size.substring(0, size.length - 2));
    }

    // Factory method to create a ScrapeRequest from a JSON object
    static fromJson(json: { [key: string]: any }): ScrapeRequest {
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
            fullpageScreenshot: json.fullpageScreenshot ?? false,
            removeCSSselectors: json.removeCSSselectors,
            actions: json.actions ? JSON.parse(json.actions) : []
        });
    }
}