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

interface DataRequestParams {
    url: string;
    orgId: string;
    recordID: string;
    waitBeforeScraping?: number;
    htmlVisualizer?: boolean;
    windowSize?: Size;
    saveHtml?: boolean;
    saveMarkdown?: boolean;
    saveText?: boolean;
    saveFile?: boolean;
    htmlTransformer?: string;
    fullpageScreenshot?: boolean;
    removeCSSselectors?: string;
    classNamesToBeRemoved?: string[];
    runScript?: boolean;
    scriptId?: string;
    fastLane?: boolean;
    waitForElement?: string;
    waitForElementTime?: number;
    removeImages?: boolean;
    customLinkParser?: boolean;
    shouldDisableJS?: boolean;
    sandBoxAttributes?: string;
    triggersDownload?: boolean;
    skipHeaders?: boolean;
    method?: string;
    method_endpoint?: string;
    method_payload?: string;
    method_headers?: any;
    fetchInstead?: boolean;
    actions?: Action[];
    rawData?: boolean;
    refPolicy?: string;
    htmlContained?: boolean;
    kc?: boolean;
    preview?: boolean;
    pascoli?: boolean;
    openInGBTab?: boolean;
    divContained?: boolean;
    aristotele?: boolean;
    save_html_endpoint?: string;
    connectionID?: string;
    json?: { [key: string]: any };
    cerealObject?: string;
}

export class DataRequest {
    url: string;
    orgId: string;
    recordID: string;
    waitBeforeScraping: number;
    htmlVisualizer?: boolean;
    windowSize: Size;
    saveHtml: boolean;
    saveMarkdown: boolean;
    saveText: boolean;
    saveFile: boolean;
    htmlTransformer: string;
    removeCSSselectors?: string;
    classNamesToBeRemoved: string[];
    fullpageScreenshot?: boolean;
    runScript: boolean;
    scriptId: string;
    fastLane: boolean;
    waitForElement: string;
    waitForElementTime: number;
    removeImages: boolean;
    customLinkParser: boolean;
    shouldDisableJS: boolean;
    sandBoxAttributes: string;
    triggersDownload: boolean;
    skipHeaders: boolean;
    method: string;
    method_endpoint: string;
    method_payload: string;
    method_headers: any;
    fetchInstead: boolean;
    actions: Action[];
    rawData: boolean;
    refPolicy: string;
    htmlContained: boolean;
    kc: boolean;
    preview: boolean;
    pascoli: boolean;
    openInGBTab: boolean;
    divContained: boolean;
    aristotele: boolean;
    save_html_endpoint: string;
    connectionID: string;
    json: { [key: string]: any };
    cerealObject: string;

    constructor({
        url,
        orgId,
        recordID,
        waitBeforeScraping = 1,
        htmlVisualizer = false,
        windowSize = { width: 1024, height: 768 },
        saveHtml = false,
        saveMarkdown = true,
        saveText = false,
        saveFile = false,
        htmlTransformer = 'none',
        fullpageScreenshot = false,
        removeCSSselectors = 'default',
        classNamesToBeRemoved = [],
        runScript = false,
        scriptId = '',
        fastLane = true,
        waitForElement = 'none',
        waitForElementTime = 0,
        removeImages = false,
        customLinkParser = false,
        shouldDisableJS = true,
        sandBoxAttributes = "allow-forms allow-orientation-lock allow-pointer-lock allow-same-origin allow-scripts",
        triggersDownload = true,
        skipHeaders = false,
        method = 'GET_NORMAL',
        method_endpoint = '',
        method_payload = 'no_payload',
        method_headers = 'no_headers',
        fetchInstead = false,
        actions = [],
        rawData = false,
        refPolicy = '',
        htmlContained = false,
        kc = false,
        preview = false,
        pascoli = false,
        openInGBTab = false,
        divContained = false,
        aristotele = false,
        save_html_endpoint = 'https://request.mellow.tel/',
        connectionID = '',
        json = {},
        cerealObject = '{}'
    }: DataRequestParams) {
        this.url = url;
        this.orgId = orgId;
        this.recordID = recordID;
        this.waitBeforeScraping = waitBeforeScraping;
        this.htmlVisualizer = htmlVisualizer;
        this.windowSize = windowSize;
        this.saveHtml = saveHtml;
        this.saveMarkdown = saveMarkdown;
        this.saveText = saveText;
        this.saveFile = saveFile;
        this.htmlTransformer = htmlTransformer;
        this.fullpageScreenshot = fullpageScreenshot;
        this.removeCSSselectors = removeCSSselectors;
        this.classNamesToBeRemoved = classNamesToBeRemoved;
        this.runScript = runScript;
        this.scriptId = scriptId;
        this.fastLane = fastLane;
        this.waitForElement = waitForElement;
        this.waitForElementTime = waitForElementTime;
        this.removeImages = removeImages;
        this.customLinkParser = customLinkParser;
        this.shouldDisableJS = shouldDisableJS;
        this.sandBoxAttributes = sandBoxAttributes;
        this.triggersDownload = triggersDownload;
        this.skipHeaders = skipHeaders;
        this.method = method;
        this.method_endpoint = method_endpoint;
        this.method_payload = method_payload;
        this.method_headers = method_headers;
        this.fetchInstead = fetchInstead;
        this.actions = actions;
        this.rawData = rawData;
        this.refPolicy = refPolicy;
        this.htmlContained = htmlContained;
        this.kc = kc;
        this.preview = preview;
        this.pascoli = pascoli;
        this.openInGBTab = openInGBTab;
        this.divContained = divContained;
        this.aristotele = aristotele;
        this.save_html_endpoint = save_html_endpoint;
        this.connectionID = connectionID;
        this.json = json;
        this.cerealObject = cerealObject;
    }

    // Helper function to parse size strings
    static _parseSize(size: string): number {
        return parseFloat(size.substring(0, size.length - 2));
    }

    // Factory method to create a DataRequest from a JSON object
    static fromJson(json: { [key: string]: any }): DataRequest {
        let parsed_headers = {};
        if (json.method_headers && json.method_headers !== 'no_headers') {
            try {
                parsed_headers = JSON.parse(json.method_headers);
            } catch (e) {
                parsed_headers = {};
            }
        }
        const params: DataRequestParams = {
            url: json.url,
            orgId: json.orgId,
            recordID: json.recordID,
            waitBeforeScraping: json.waitBeforeScraping,
            htmlVisualizer: json.htmlVisualizer,
            windowSize: json.screen_width && json.screen_height
                ? { width: DataRequest._parseSize(json.screen_width), height: DataRequest._parseSize(json.screen_height) }
                : { width: 1024, height: 768 },
            saveHtml: json.saveHtml,
            saveMarkdown: json.saveMarkdown,
            saveText: json.saveText,
            saveFile: json.saveFile,
            htmlTransformer: json.htmlTransformer,
            removeCSSselectors: json.removeCSSselectors,
            classNamesToBeRemoved: json.classNamesToBeRemoved ? JSON.parse(json.classNamesToBeRemoved) : [],
            runScript: json.runScript,
            scriptId: json.scriptId,
            fastLane: json.fastLane,
            waitForElement: json.waitForElement,
            waitForElementTime: json.waitForElementTime,
            removeImages: json.removeImages,
            customLinkParser: json.customLinkParser,
            shouldDisableJS: json.shouldDisableJS,
            sandBoxAttributes: json.sandBoxAttributes,
            triggersDownload: json.triggersDownload,
            skipHeaders: json.skipHeaders,
            method: json.method,
            method_endpoint: json.method_endpoint,
            method_payload: json.method_payload,
            method_headers: parsed_headers,
            fetchInstead: json.fetchInstead,
            actions: json.actions ? JSON.parse(json.actions) : [],
            rawData: json.rawData,
            refPolicy: json.refPolicy,
            htmlContained: json.htmlContained,
            kc: json.kc,
            preview: json.preview,
            pascoli: json.pascoli,
            openInGBTab: json.openInGBTab,
            divContained: json.divContained,
            aristotele: json.aristotele,
            save_html_endpoint: json.save_html_endpoint,
            connectionID: json.connectionID,
            json: json,
            cerealObject: json.cerealObject,
        };
        return new DataRequest(params);
    }
}
