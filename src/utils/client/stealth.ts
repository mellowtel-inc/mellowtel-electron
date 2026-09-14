import { ResolvedClient } from "./types";

function js(value: unknown): string {
    return JSON.stringify(value);
}

export function buildStealthScript(client: ResolvedClient): string {
    const parts: string[] = [
        `(function() {`,
        `'use strict';`,
        `window.alert = function() { return undefined; };`,
        `window.confirm = function() { return false; };`,
        `window.prompt = function() { return null; };`,
        `window.print = function() { return undefined; };`,
    ];

    if (client.hideWebdriver) {
        parts.push(
            `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`,
            `try { delete navigator.__proto__.webdriver; } catch(e) {}`
        );
    }

    if (client.chromeObject) {
        parts.push(`
            Object.defineProperty(window, 'chrome', {
                writable: true,
                enumerable: true,
                configurable: false,
                value: {
                    runtime: {
                        onConnect: undefined,
                        onMessage: undefined,
                        connect: function() {},
                        sendMessage: function() {},
                    },
                    loadTimes: function() { return {}; },
                    csi: function() { return {}; },
                },
            });
        `);
    }

    if (client.plugins) {
        parts.push(`
            const makePluginArray = () => {
                const plugins = ${js(client.plugins)};
                const arr = Object.create(PluginArray.prototype);
                plugins.forEach((p, i) => {
                    const plugin = Object.create(Plugin.prototype);
                    Object.defineProperties(plugin, {
                        name: { value: p.name, enumerable: true },
                        filename: { value: p.filename, enumerable: true },
                        description: { value: p.description, enumerable: true },
                        length: { value: 0, enumerable: true },
                    });
                    arr[i] = plugin;
                });
                Object.defineProperties(arr, {
                    length: { value: plugins.length, enumerable: true },
                    item: { value: (i) => arr[i] || null },
                    namedItem: { value: (n) => plugins.find(p => p.name === n) || null },
                    refresh: { value: () => {} },
                });
                return arr;
            };
            Object.defineProperty(navigator, 'plugins', { get: makePluginArray });
        `);
    }

    parts.push(`
        Object.defineProperty(navigator, 'languages', {
            get: () => Object.freeze(${js(client.languages)})
        });
        if (window.outerWidth === 0) {
            Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
        }
        if (window.outerHeight === 0) {
            Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + ${js(client.outerInset)} });
        }
    `);

    if (client.webgl) {
        parts.push(`
            const hookWebGL = (proto) => {
                const original = proto.getParameter;
                proto.getParameter = function(param) {
                    if (param === 37445) return ${js(client.webgl && client.webgl.vendor)};
                    if (param === 37446) return ${js(client.webgl && client.webgl.renderer)};
                    return original.call(this, param);
                };
            };
            hookWebGL(WebGLRenderingContext.prototype);
            if (typeof WebGL2RenderingContext !== 'undefined') {
                hookWebGL(WebGL2RenderingContext.prototype);
            }
        `);
    }

    parts.push(`
        if (navigator.permissions) {
            const orig = navigator.permissions.query.bind(navigator.permissions);
            navigator.permissions.query = (params) => {
                if (params.name === 'notifications') {
                    return Promise.resolve({ state: 'prompt', onchange: null });
                }
                return orig(params).catch(() => ({ state: 'prompt', onchange: null }));
            };
        }
        Object.defineProperty(screen, 'availTop', { value: ${js(client.screen.availTop)} });
        Object.defineProperty(screen, 'availLeft', { value: ${js(client.screen.availLeft)} });
        Object.defineProperty(screen, 'colorDepth', { value: ${js(client.screen.colorDepth)} });
        Object.defineProperty(screen, 'pixelDepth', { value: ${js(client.screen.pixelDepth)} });
        Object.defineProperty(navigator, 'hardwareConcurrency', { value: ${js(client.hardwareConcurrency)} });
        Object.defineProperty(navigator, 'deviceMemory', { value: ${js(client.deviceMemory)} });
    `);

    if (client.connectionRtt !== false) {
        parts.push(`
            if (navigator.connection) {
                Object.defineProperty(navigator.connection, 'rtt', { value: ${js(client.connectionRtt)} });
            }
        `);
    }

    if (client.pointerNoise) {
        parts.push(`
            let mouseX = Math.floor(Math.random() * window.innerWidth);
            let mouseY = Math.floor(Math.random() * window.innerHeight);
            const mouseInterval = setInterval(() => {
                mouseX += (Math.random() - 0.5) * 5;
                mouseY += (Math.random() - 0.5) * 5;
                mouseX = Math.max(0, Math.min(window.innerWidth, mouseX));
                mouseY = Math.max(0, Math.min(window.innerHeight, mouseY));
                document.dispatchEvent(new MouseEvent('mousemove', {
                    clientX: mouseX, clientY: mouseY, bubbles: true
                }));
            }, 100 + Math.random() * 200);
            window.addEventListener('beforeunload', () => clearInterval(mouseInterval));
        `);
    }

    if (client.timerJitter) {
        parts.push(`
            const origTimeout = window.setTimeout;
            window.setTimeout = function(fn, delay, ...args) {
                return origTimeout(fn, Math.max(0, (delay || 0) + (Math.random() * 10 - 5)), ...args);
            };
        `);
    }

    parts.push(`
        window.Notification = function() { throw new Error('Disabled'); };
        window.Notification.permission = 'denied';
        window.Notification.requestPermission = () => Promise.resolve('denied');
        window.PaymentRequest = undefined;
        window.showOpenFilePicker = undefined;
        window.showSaveFilePicker = undefined;
        window.showDirectoryPicker = undefined;
        navigator.share = undefined;
        navigator.canShare = () => false;
        if (navigator.credentials) {
            navigator.credentials.get = () => Promise.reject(new Error('Disabled'));
            navigator.credentials.store = () => Promise.reject(new Error('Disabled'));
            navigator.credentials.create = () => Promise.reject(new Error('Disabled'));
        }
        Element.prototype.requestFullscreen = () => Promise.reject(new Error('Disabled'));
        if (Element.prototype.webkitRequestFullscreen) {
            Element.prototype.webkitRequestFullscreen = function() {};
        }
        const originalClick = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function() {
            if (this.type === 'file') return;
            return originalClick.call(this);
        };
        document.addEventListener('keydown', function(e) {
            if (e.ctrlKey || e.metaKey) {
                if (['p', 's', 'f', 'o', 'n'].includes(e.key.toLowerCase())) {
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                }
            }
        }, true);
    })();
    `);

    return parts.join("\n");
}
