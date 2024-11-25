import { BrowserWindow } from 'electron';
interface MellowtelSDKOptions {
    disableLogs: boolean;
}
export default class MellowtelSDK {
    private configurationKey;
    private nodeId;
    private options?;
    private disableLogs;
    private wsManager;
    /**
     * Creates an instance of MellowtelSDK.
     * @param publishableKey - The publishable key for the SDK.
     * @param options - Optional configuration options.
     */
    constructor(publishableKey: string, options?: MellowtelSDKOptions);
    /**
     * Initializes the SDK.
     * @returns Promise<void>
     * @throws Error if the publishableKey is undefined, null, or empty.
     */
    init(): Promise<void>;
    /**
     * Requests user consent.
     * @param window - The Electron BrowserWindow instance.
     * @param incentive - The incentive to show in the consent dialog.
     * @returns Promise<void>
     */
    requestConsent(window: BrowserWindow, incentive: string): Promise<void>;
    /**
     * Shows the consent settings dialog.
     * @param window - The Electron BrowserWindow instance.
     * @returns Promise<void>
     */
    showConsentSettings(window: BrowserWindow): Promise<void>;
    /**
     * Gets the current opt-in status.
     * @returns boolean - Returns true if the user is opted in, false otherwise.
     */
    getOptInStatus(): boolean;
    /**
     * Opts in to the service and initializes WebSocket if not already initialized.
     * @returns Promise<void>
     */
    optIn(): Promise<void>;
    /**
     * Opts out of the service and disconnects WebSocket if connected.
     * @returns Promise<void>
     */
    optOut(): Promise<void>;
}
export {};
