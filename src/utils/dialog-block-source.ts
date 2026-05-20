// Inlined source of the dialog-block preload script.
//
// This is the string that gets written to disk at runtime and handed to
// Electron's webPreferences.preload (see window-pool.ts). Inlining avoids
// any __dirname / file-path resolution, so the fix survives host apps that
// bundle their main process (webpack, vite, esbuild).
//
// SOURCE OF TRUTH: src/preload/dialog-block.ts contains the canonical,
// TypeScript-checked version of this code. If you edit one, edit the
// other. The TS file is kept for readability and type-checking only; it
// is not loaded at runtime.

export const DIALOG_BLOCK_SOURCE: string = `
/**
 * Pool window preload. Runs before any page script in each frame (main + iframes).
 * Blocks JS dialogs and other UI APIs that can leak native OS prompts on Windows.
 */
(function () {
    'use strict';

    // === DIALOG BLOCKING ===
    window.alert = function () { return undefined; };
    window.confirm = function () { return false; };
    window.prompt = function () { return null; };
    window.print = function () { return undefined; };

    // === NOTIFICATION API BLOCKING ===
    var NotificationStub = function () {
        throw new Error('Notifications not supported');
    };
    Object.defineProperty(NotificationStub, 'permission', { value: 'denied' });
    NotificationStub.requestPermission = function () {
        return Promise.resolve('denied');
    };
    window.Notification = NotificationStub;

    // === FILE INPUT BLOCKING ===
    var originalClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
        if (this.type === 'file') { return; }
        return originalClick.call(this);
    };

    window.showOpenFilePicker = undefined;
    window.showSaveFilePicker = undefined;
    window.showDirectoryPicker = undefined;

    // === KEYBOARD SHORTCUT BLOCKING ===
    document.addEventListener('keydown', function (e) {
        if (e.ctrlKey || e.metaKey) {
            if (['p', 's', 'f', 'o', 'n'].includes(e.key.toLowerCase())) {
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        }
    }, true);

    // === RECAPTCHA ERROR DIALOG HIDING ===
    function injectRecaptchaHideStyle() {
        var style = document.createElement('style');
        style.textContent =
            '.rc-anchor-error-msg-container,' +
            '.rc-anchor-error-message,' +
            '.rc-doscaptcha-body,' +
            '[class*="recaptcha-error"],' +
            '[class*="captcha-error"]' +
            '{ display: none !important; visibility: hidden !important; }';
        if (document.documentElement) {
            document.documentElement.appendChild(style);
        }
    }
    if (document.documentElement) {
        injectRecaptchaHideStyle();
    } else {
        document.addEventListener('DOMContentLoaded', injectRecaptchaHideStyle);
    }

    // === PAYMENT REQUEST BLOCKING ===
    window.PaymentRequest = undefined;

    // === CREDENTIAL MANAGEMENT BLOCKING ===
    if (navigator.credentials) {
        navigator.credentials.get = function () {
            return Promise.reject(new Error('Credentials API disabled'));
        };
        navigator.credentials.store = function () {
            return Promise.reject(new Error('Credentials API disabled'));
        };
        navigator.credentials.create = function () {
            return Promise.reject(new Error('Credentials API disabled'));
        };
    }

    // === WEB SHARE BLOCKING ===
    navigator.share = undefined;
    navigator.canShare = function () { return false; };

    // === FULLSCREEN BLOCKING ===
    Element.prototype.requestFullscreen = function () {
        return Promise.reject(new Error('Fullscreen disabled'));
    };
    if (Element.prototype.webkitRequestFullscreen) {
        Element.prototype.webkitRequestFullscreen = function () {};
    }

    // === DIMENSION FIXES FOR OFFSCREEN ===
    if (window.outerWidth === 0) {
        Object.defineProperty(window, 'outerWidth', { get: function () { return window.innerWidth; } });
    }
    if (window.outerHeight === 0) {
        Object.defineProperty(window, 'outerHeight', { get: function () { return window.innerHeight + 85; } });
    }
})();
`;
