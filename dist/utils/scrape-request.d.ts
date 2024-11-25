interface Size {
    width: number;
    height: number;
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
    removeCSSselectors?: string;
}
export declare class ScrapeRequest {
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
    constructor({ url, orgId, recordID, waitBeforeScraping, htmlVisualizer, windowSize, saveHtml, saveMarkdown, htmlTransformer, removeCSSselectors, }: ScrapeRequestParams);
    static _parseSize(size: string): number;
    static fromJson(json: {
        [key: string]: any;
    }): ScrapeRequest;
}
export {};
