import { ScrapeRequest } from './scrape-request';
export declare function scrapeUrl(scrapeRequest: ScrapeRequest): Promise<{
    html: string;
    markdown: string;
    screenshot: Buffer | undefined;
}>;
export declare function getS3SignedUrls(recordID: string): Promise<{
    uploadURL_html: string;
    uploadURL_markDown: string;
    uploadURL_htmlVisualizer: string;
}>;
