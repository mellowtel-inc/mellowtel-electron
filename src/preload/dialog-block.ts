/**
 * Pool window preload. Runs before any page script in each frame (main + iframes).
 * Blocks JS dialogs and other UI APIs that can leak native OS prompts on Windows.
 *
 * REFERENCE ONLY. This file is the type-checked, readable version of the
 * preload. It is NOT loaded at runtime. The runtime version is the string
 * constant in src/utils/dialog-block-source.ts. If you edit this file,
 * mirror the change there.
 */
(function () {
    'use strict';

    // === DIALOG BLOCKING ===
    window.alert = function () {
        return undefined;
    };
    window.confirm = function () {
        return false;
    };
    window.prompt = function () {
        return null;
    };
    window.print = function () {
        return undefined;
    };

    // === NOTIFICATION API BLOCKING ===
    const NotificationStub = function () {
        throw new Error('Notifications not supported');
    } as unknown as typeof Notification;
    Object.defineProperty(NotificationStub, 'permission', { value: 'denied' });
    NotificationStub.requestPermission = function () {
        return Promise.resolve('denied' as NotificationPermission);
    };
    window.Notification = NotificationStub;

    // === FILE INPUT BLOCKING ===
    const originalClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
        if (this.type === 'file') {
            return;
        }
        return originalClick.call(this);
    };

    (window as Window & { showOpenFilePicker?: unknown }).showOpenFilePicker = undefined;
    (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
    (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker = undefined;

    // === KEYBOARD SHORTCUT BLOCKING ===
    document.addEventListener(
        'keydown',
        function (e) {
            if (e.ctrlKey || e.metaKey) {
                if (['p', 's', 'f', 'o', 'n'].includes(e.key.toLowerCase())) {
                    e.preventDefault();
                    e.stopPropagation();
                    return false;
                }
            }
        },
        true
    );

    // === RECAPTCHA ERROR DIALOG HIDING ===
    function injectRecaptchaHideStyle() {
        const style = document.createElement('style');
        style.textContent = `
            .rc-anchor-error-msg-container,
            .rc-anchor-error-message,
            .rc-doscaptcha-body,
            [class*="recaptcha-error"],
            [class*="captcha-error"] {
                display: none !important;
                visibility: hidden !important;
            }
        `;
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
    (window as Window & { PaymentRequest?: unknown }).PaymentRequest = undefined;

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
    (navigator as unknown as { share?: unknown }).share = undefined;
    navigator.canShare = function () {
        return false;
    };

    // === FULLSCREEN BLOCKING ===
    Element.prototype.requestFullscreen = function () {
        return Promise.reject(new Error('Fullscreen disabled'));
    };
    const elementProto = Element.prototype as Element & {
        webkitRequestFullscreen?: () => void;
    };
    if (elementProto.webkitRequestFullscreen) {
        elementProto.webkitRequestFullscreen = function () {};
    }

    // === DIMENSION FIXES FOR OFFSCREEN ===
    if (window.outerWidth === 0) {
        Object.defineProperty(window, 'outerWidth', {
            get: () => window.innerWidth,
        });
    }
    if (window.outerHeight === 0) {
        Object.defineProperty(window, 'outerHeight', {
            get: () => window.innerHeight + 85,
        });
    }
})();
