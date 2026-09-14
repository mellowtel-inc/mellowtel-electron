import { app } from "electron";
import * as os from "os";
import { ClientConfig } from "./types";

function chromeVersion(): string {
    return process.versions.chrome || "139.0.0.0";
}

function chromeMajor(): string {
    return chromeVersion().split(".")[0] || "139";
}

function platformLabel(): "Windows" | "macOS" | "Linux" {
    const platform = os.platform();
    if (platform === "win32") {
        return "Windows";
    }
    if (platform === "darwin") {
        return "macOS";
    }
    return "Linux";
}

function deviceUserAgent(): string {
    const chrome = chromeVersion();
    const platform = os.platform();
    if (platform === "win32") {
        return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
    }
    if (platform === "linux") {
        return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
    }
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`;
}

function deviceLocale(): string {
    try {
        if (typeof app?.getLocale === "function" && app.isReady()) {
            const locale = app.getLocale();
            if (locale) {
                return locale;
            }
        }
    } catch {
        // app may not be ready
    }
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
}

function languagesFromLocale(locale: string): string[] {
    const normalized = locale.replace("_", "-");
    const base = normalized.split("-")[0];
    if (base && base.toLowerCase() !== normalized.toLowerCase()) {
        return [normalized, base];
    }
    return [normalized];
}

function acceptLanguageFromLanguages(languages: string[]): string {
    return languages
        .map((lang, index) => (index === 0 ? lang : `${lang};q=${Math.max(0.1, 1 - index * 0.1).toFixed(1)}`))
        .join(",");
}

function deviceMemoryGb(): number {
    const gb = os.totalmem() / (1024 * 1024 * 1024);
    const buckets = [0.25, 0.5, 1, 2, 4, 8];
    let matched = buckets[0];
    for (const bucket of buckets) {
        if (gb >= bucket) {
            matched = bucket;
        }
    }
    return matched;
}

/**
 * Real-device identity. Used as the base for UA, locale, client hints, and hardware.
 * Does not invent Referer, WebGL, or stealth patches.
 */
export function getDeviceClient(): ClientConfig {
    const locale = deviceLocale();
    const languages = languagesFromLocale(locale);
    const acceptLanguage = acceptLanguageFromLanguages(languages);
    const major = chromeMajor();
    const platform = platformLabel();

    return {
        userAgent: deviceUserAgent(),
        acceptLanguage,
        languages,
        hardwareConcurrency: Math.max(1, os.cpus().length),
        deviceMemory: deviceMemoryGb(),
        headers: {
            "sec-ch-ua": `"Not_A Brand";v="8", "Chromium";v="${major}", "Google Chrome";v="${major}"`,
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": `"${platform}"`,
            "accept-language": acceptLanguage,
        },
    };
}
