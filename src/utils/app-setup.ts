import { app } from 'electron';

/**
 * Configures Electron app with command-line flags to prevent system dialogs.
 *
 * IMPORTANT: This function MUST be called BEFORE app.ready event.
 * Call this as early as possible in your main process, ideally at the top of your entry file.
 *
 * @example
 * ```typescript
 * import { setupMellowtelApp } from 'mellowtel-electron';
 *
 * // Call before app.ready
 * setupMellowtelApp();
 *
 * app.whenReady().then(() => {
 *   // Your app initialization
 * });
 * ```
 */
export function setupMellowtelApp(): void {
    // Disable features that can trigger system dialogs
    app.commandLine.appendSwitch('disable-features', [
        'AutofillServerCommunication',  // Autofill popups
        'MediaRouter',                   // Chromecast dialog
        'TranslateUI',                   // Translation bar
        'GlobalMediaControls',           // Media controls overlay
    ].join(','));

    // Disable hardware security features that trigger Windows Security
    app.commandLine.appendSwitch('disable-client-side-phishing-detection');

    // Disable Windows-specific auth helpers (NTLM/Kerberos dialogs)
    app.commandLine.appendSwitch('disable-http-auth-negotiate');

    // Prevent password manager integration
    app.commandLine.appendSwitch('disable-save-password-bubble');

    // Disable features that might show permission prompts
    app.commandLine.appendSwitch('use-fake-device-for-media-stream');
    app.commandLine.appendSwitch('use-fake-ui-for-media-stream');

    // Disable crash reporter UI
    app.commandLine.appendSwitch('disable-breakpad');

    // Disable GPU error dialogs
    app.commandLine.appendSwitch('disable-gpu-process-crash-limit');

    // Disable automation detection banner
    app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

    // No first run dialogs
    app.commandLine.appendSwitch('no-first-run');
    app.commandLine.appendSwitch('no-default-browser-check');
}
