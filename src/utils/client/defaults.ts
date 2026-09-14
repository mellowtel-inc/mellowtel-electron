import { ClientConfig, DEFAULT_PLUGINS } from "./types";

/**
 * Today's hardcoded scrape behavior, except device-derived fields
 * (UA, locale, hardware, client hints) which come from getDeviceClient().
 */
export function getCurrentClientDefaults(): ClientConfig {
    return {
        referrer: "https://www.google.com/",
        headers: {
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "cross-site",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "accept-encoding": "gzip, deflate, br, zstd",
            "cache-control": "max-age=0",
        },
        webgl: {
            vendor: "Google Inc. (Intel)",
            renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.1)",
        },
        screen: {
            colorDepth: 24,
            pixelDepth: 24,
            availTop: 0,
            availLeft: 0,
        },
        connectionRtt: 50,
        hideWebdriver: true,
        chromeObject: true,
        plugins: DEFAULT_PLUGINS,
        outerInset: 85,
        pointerNoise: true,
        timerJitter: true,
    };
}
