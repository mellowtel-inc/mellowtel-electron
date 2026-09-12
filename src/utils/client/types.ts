export interface ClientWebgl {
    vendor: string;
    renderer: string;
}

export interface ClientScreen {
    colorDepth: number;
    pixelDepth: number;
    availTop: number;
    availLeft: number;
}

export interface ClientPlugin {
    name: string;
    filename: string;
    description: string;
}

/** Sparse per-scrape overlay. Omitted fields use device helper + current defaults. */
export interface ClientConfig {
    userAgent?: string;
    acceptLanguage?: string;
    /** false = do not force a Referer. */
    referrer?: string | false;
    languages?: string[];
    headers?: Record<string, string>;
    hardwareConcurrency?: number;
    deviceMemory?: number;
    /** false = do not hook WebGL (real GPU). resolveClient fills in whichever
     *  of vendor/renderer is omitted from the current default, so a sparse
     *  overlay here is valid. */
    webgl?: Partial<ClientWebgl> | false;
    screen?: Partial<ClientScreen>;
    /** false = do not override rtt. */
    connectionRtt?: number | false;
    hideWebdriver?: boolean;
    chromeObject?: boolean;
    plugins?: boolean | ClientPlugin[];
    outerInset?: number;
    pointerNoise?: boolean;
    timerJitter?: boolean;
}

export interface ResolvedClient {
    userAgent: string;
    acceptLanguage: string;
    referrer: string | false;
    languages: string[];
    headers: Record<string, string>;
    hardwareConcurrency: number;
    deviceMemory: number;
    webgl: ClientWebgl | false;
    screen: ClientScreen;
    connectionRtt: number | false;
    hideWebdriver: boolean;
    chromeObject: boolean;
    plugins: false | ClientPlugin[];
    outerInset: number;
    pointerNoise: boolean;
    timerJitter: boolean;
}

export const DEFAULT_PLUGINS: ClientPlugin[] = [
    { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
    { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
    { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function sanitizeBoolean(value: unknown): boolean | undefined {
    return typeof value === "boolean" ? value : undefined;
}

function sanitizeNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value) || value.length === 0) {
        return undefined;
    }
    return value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

function sanitizeHeaders(value: unknown): Record<string, string> | undefined {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sanitizeReferrer(value: unknown): string | false | undefined {
    if (value === false) {
        return false;
    }
    return sanitizeString(value);
}

function sanitizeConnectionRtt(value: unknown): number | false | undefined {
    if (value === false) {
        return false;
    }
    return sanitizeNumber(value);
}

function sanitizeWebgl(value: unknown): Partial<ClientWebgl> | false | undefined {
    if (value === false) {
        return false;
    }
    if (!isPlainObject(value)) {
        return undefined;
    }
    const result: Partial<ClientWebgl> = {};
    const vendor = sanitizeString(value.vendor);
    const renderer = sanitizeString(value.renderer);
    if (vendor !== undefined) {
        result.vendor = vendor;
    }
    if (renderer !== undefined) {
        result.renderer = renderer;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeScreen(value: unknown): Partial<ClientScreen> | undefined {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const result: Partial<ClientScreen> = {};
    const colorDepth = sanitizeNumber(value.colorDepth);
    const pixelDepth = sanitizeNumber(value.pixelDepth);
    const availTop = sanitizeNumber(value.availTop);
    const availLeft = sanitizeNumber(value.availLeft);
    if (colorDepth !== undefined) {
        result.colorDepth = colorDepth;
    }
    if (pixelDepth !== undefined) {
        result.pixelDepth = pixelDepth;
    }
    if (availTop !== undefined) {
        result.availTop = availTop;
    }
    if (availLeft !== undefined) {
        result.availLeft = availLeft;
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeClientPlugin(value: unknown): ClientPlugin | undefined {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const name = sanitizeString(value.name);
    const filename = sanitizeString(value.filename);
    const description = sanitizeString(value.description);
    if (name === undefined || filename === undefined || description === undefined) {
        return undefined;
    }
    return { name, filename, description };
}

function sanitizePlugins(value: unknown): boolean | ClientPlugin[] | undefined {
    if (value === true || value === false) {
        return value;
    }
    if (!Array.isArray(value)) {
        return undefined;
    }
    const plugins = value
        .map(sanitizeClientPlugin)
        .filter((plugin): plugin is ClientPlugin => plugin !== undefined);
    return plugins.length > 0 ? plugins : undefined;
}

/**
 * Sanitizes each known field independently instead of trusting the raw job
 * payload's shape. A wrongly-typed field (e.g. `languages` sent as a string,
 * `hardwareConcurrency` sent as a string) is dropped entirely rather than
 * passed through: resolveClient's `??` fallback chain only guards against
 * `undefined`, so a wrong-but-truthy value would otherwise flow straight into
 * navigator.* / the stealth script (e.g. freezing navigator.languages to a
 * non-array, or reporting navigator.hardwareConcurrency as a string) - exactly
 * the kind of type anomaly this stealth layer exists to avoid.
 */
export function parseClient(raw: unknown): ClientConfig {
    let source = raw;
    if (typeof raw === "string") {
        try {
            source = JSON.parse(raw);
        } catch {
            return {};
        }
    }
    if (!isPlainObject(source)) {
        return {};
    }

    const client: ClientConfig = {};

    const userAgent = sanitizeString(source.userAgent);
    if (userAgent !== undefined) client.userAgent = userAgent;

    const acceptLanguage = sanitizeString(source.acceptLanguage);
    if (acceptLanguage !== undefined) client.acceptLanguage = acceptLanguage;

    const referrer = sanitizeReferrer(source.referrer);
    if (referrer !== undefined) client.referrer = referrer;

    const languages = sanitizeStringArray(source.languages);
    if (languages !== undefined) client.languages = languages;

    const headers = sanitizeHeaders(source.headers);
    if (headers !== undefined) client.headers = headers;

    const hardwareConcurrency = sanitizeNumber(source.hardwareConcurrency);
    if (hardwareConcurrency !== undefined) client.hardwareConcurrency = hardwareConcurrency;

    const deviceMemory = sanitizeNumber(source.deviceMemory);
    if (deviceMemory !== undefined) client.deviceMemory = deviceMemory;

    const webgl = sanitizeWebgl(source.webgl);
    if (webgl !== undefined) client.webgl = webgl;

    const screen = sanitizeScreen(source.screen);
    if (screen !== undefined) client.screen = screen;

    const connectionRtt = sanitizeConnectionRtt(source.connectionRtt);
    if (connectionRtt !== undefined) client.connectionRtt = connectionRtt;

    const hideWebdriver = sanitizeBoolean(source.hideWebdriver);
    if (hideWebdriver !== undefined) client.hideWebdriver = hideWebdriver;

    const chromeObject = sanitizeBoolean(source.chromeObject);
    if (chromeObject !== undefined) client.chromeObject = chromeObject;

    const plugins = sanitizePlugins(source.plugins);
    if (plugins !== undefined) client.plugins = plugins;

    const outerInset = sanitizeNumber(source.outerInset);
    if (outerInset !== undefined) client.outerInset = outerInset;

    const pointerNoise = sanitizeBoolean(source.pointerNoise);
    if (pointerNoise !== undefined) client.pointerNoise = pointerNoise;

    const timerJitter = sanitizeBoolean(source.timerJitter);
    if (timerJitter !== undefined) client.timerJitter = timerJitter;

    return client;
}
