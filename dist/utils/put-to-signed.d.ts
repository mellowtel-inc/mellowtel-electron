export declare function putHTMLToSigned(htmlURL_signed: string, content: string): Promise<unknown>;
export declare function putMarkdownToSigned(markdownURL_signed: string, markDown: string): Promise<unknown>;
export declare function putHTMLVisualizerToSigned(htmlVisualizerURL_signed: string, base64image: Buffer): Promise<unknown>;
export declare function putHTMLContainedToSigned(htmlContainedURL_signed: string, htmlContainedString: string): Promise<unknown>;
export declare function updateDynamo(recordID: string, url: string, htmlTransformer: string, orgId: string, htmlKey?: string, markdownKey?: string, htmlVisualizerKey?: string): Promise<void>;
