import {
    Action,
    ActionJobSettings,
    ActionResult,
    DEFAULT_ACTION_TIMEOUT_MS,
    InputStyle,
    OnActionError,
    parseActions,
    parseNaturalInput,
    parseTypingConfig,
    TypingConfig,
} from "./actions/types";
import { JarMode, parseJarMode, parseResetJar, ResetJar } from "./jar/types";
import { ClientConfig, parseClient } from "./client";

interface Size {
    width: number;
    height: number;
}

export type { Action, ActionJobSettings, ActionResult, TypingConfig };

export interface FormField {
    name: string;
    value: string;
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
    /** Per-job URL that receives structured error reports. Empty = do not POST. */
    error_callback_endpoint?: string;
    connectionID?: string;
    json?: { [key: string]: any };
    cerealObject?: string;
    parser_job?: boolean;
    /** Optional. Caps how many Chromium windows the app-wide WindowPool may
     *  have open at once, overriding its default (currently 2). See
     *  WindowPool.getInstance in window-pool.ts - this is a process-wide
     *  singleton, so only the value from whichever request initializes the
     *  pool actually takes effect. */
    maxWindows?: number;
    /** empty: ignore stored origin data. reuse: load, do not keep this visit's cookies.
     *  update: load and keep this visit. Default empty. */
    jar?: JarMode;
    /** Wipe stored jar data before load. origin uses this job's URL. Default none. */
    resetJar?: ResetJar;
    /** Optional per-scrape presentation overlay. Omitted fields use the device
     *  helper (UA, locale, hardware) plus current scrape defaults. */
    client?: ClientConfig;
    input?: InputStyle;
    onActionError?: OnActionError;
    actionTimeoutMs?: number;
    typing?: TypingConfig;
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
    error_callback_endpoint: string;
    connectionID: string;
    json: { [key: string]: any };
    cerealObject: string;
    parser_job: boolean;
    maxWindows?: number;
    jar: JarMode;
    resetJar: ResetJar;
    client: ClientConfig;
    natural: boolean;
    onActionError: OnActionError;
    actionTimeoutMs: number;
    typing: TypingConfig;
    actionResults: ActionResult[];

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
        error_callback_endpoint = '',
        connectionID = '',
        json = {},
        cerealObject = '{}',
        parser_job = false,
        maxWindows,
        jar,
        resetJar,
        client,
        input,
        onActionError = 'continue',
        actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
        typing
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
        this.error_callback_endpoint = error_callback_endpoint || '';
        this.connectionID = connectionID;
        this.json = json;
        this.cerealObject = cerealObject;
        this.parser_job = parser_job;
        this.maxWindows = maxWindows;
        this.jar = parseJarMode(jar);
        this.resetJar = parseResetJar(resetJar);
        this.client = parseClient(client);
        this.natural = parseNaturalInput(input);
        this.onActionError = onActionError === 'abort' ? 'abort' : 'continue';
        this.actionTimeoutMs = typeof actionTimeoutMs === 'number' && actionTimeoutMs > 0 ? actionTimeoutMs : DEFAULT_ACTION_TIMEOUT_MS;
        this.typing = typing ?? parseTypingConfig(undefined, this.natural);
        this.actionResults = [];
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
            actions: parseActions(json.actions),
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
            error_callback_endpoint: json.error_callback_endpoint || json.error_endpoint || '',
            connectionID: json.connectionID,
            json: json,
            cerealObject: json.cerealObject,
            parser_job: json.parser_job,
            maxWindows: json.maxWindows,
            jar: parseJarMode(json.jar),
            resetJar: parseResetJar(json.resetJar),
            client: parseClient(json.client),
            input: json.input,
            onActionError: json.onActionError === 'abort' ? 'abort' : 'continue',
            actionTimeoutMs: json.actionTimeoutMs,
            typing: parseTypingConfig(json.typing, parseNaturalInput(json.input)),
        };
        return new DataRequest(params);
    }

    actionSettings(): ActionJobSettings {
        return {
            natural: this.natural,
            onActionError: this.onActionError,
            actionTimeoutMs: this.actionTimeoutMs,
            typing: this.typing,
        };
    }
}
