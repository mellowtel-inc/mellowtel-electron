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
      removeCSSselectors = '',
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
      this.removeCSSselectors = removeCSSselectors;
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
        removeCSSselectors: json.removeCSSselectors
      });
    }
  
    // Convert the ScrapeRequest to a JSON object
    toJson(): { [key: string]: any } {
      return {
        url: this.url,
        orgId: this.orgId,
        recordID: this.recordID,
        waitBeforeScraping: this.waitBeforeScraping,
        htmlVisualizer: this.htmlVisualizer,
        screen_width: this.windowSize ? `${this.windowSize.width}px` : null,
        screen_height: this.windowSize ? `${this.windowSize.height}px` : null,
        saveHtml: this.saveHtml,
        saveMarkdown: this.saveMarkdown,
        htmlTransformer: this.htmlTransformer,
        removeCSSselectors: this.removeCSSselectors,
      };
    }
  
    toString(): string {
      return `ScrapeRequest(url: ${this.url}, waitBeforeScraping: ${this.waitBeforeScraping}, htmlVisualizer: ${this.htmlVisualizer}, windowSize: ${this.windowSize}, recordID: ${this.recordID})`;
    }
  }
  
//   // Example usage
//   const jsonData = {
//     url: "https://example.com",
//     orgId: "org123",
//     recordID: "rec456",
//     waitBeforeScraping: 5,
//     htmlVisualizer: true,
//     screen_width: "1280px",
//     screen_height: "720px",
//     saveHtml: true,
//     saveMarkdown: false,
//     htmlTransformer: "custom",
//     removeCSSselectors: ".ads",
//     actions: '[{"action": "click", "selector": "#button"}]'
//   };
  
//   const scrapeRequest = ScrapeRequest.fromJson(jsonData);
//   console.log(scrapeRequest.toString());
//   console.log(scrapeRequest.toJson());