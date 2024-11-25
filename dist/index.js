"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const identity_helpers_1 = require("./utils/identity-helpers");
const logger_1 = require("./logger/logger");
const websockets_1 = require("./websockets");
const storage_helpers_1 = require("./storage/storage-helpers");
const consent_setttings_1 = require("./consent/consent-setttings");
const consent_dialog_1 = require("./consent/consent-dialog");
const OPT_IN_STATUS_KEY = "mellowtel_opt_in_status";
class MellowtelSDK {
    /**
     * Creates an instance of MellowtelSDK.
     * @param publishableKey - The publishable key for the SDK.
     * @param options - Optional configuration options.
     */
    constructor(publishableKey, options) {
        this.disableLogs = true;
        this.wsManager = websockets_1.WebSocketManager.getInstance();
        this.configurationKey = publishableKey;
        this.options = options;
        this.disableLogs = options?.disableLogs !== undefined ? options.disableLogs : true;
        logger_1.Logger.disableLogs = this.disableLogs;
        this.nodeId = (0, identity_helpers_1.getOrGenerateIdentifier)(publishableKey);
        logger_1.Logger.log(this.nodeId);
    }
    /**
     * Initializes the SDK.
     * @returns Promise<void>
     * @throws Error if the publishableKey is undefined, null, or empty.
     */
    async init() {
        if (!this.configurationKey) {
            throw new Error("publishableKey is undefined, null, or empty");
        }
        if (!this.getOptInStatus()) {
            logger_1.Logger.log("User is not opted in. WebSocket connection will not be established.");
            return;
        }
        await this.wsManager.initialize(this.nodeId);
        logger_1.Logger.log("Mellowtel SDK initialized");
    }
    /**
     * Requests user consent.
     * @param window - The Electron BrowserWindow instance.
     * @param incentive - The incentive to show in the consent dialog.
     * @returns Promise<void>
     */
    async requestConsent(window, incentive) {
        if ((0, storage_helpers_1.getLocalStorage)(OPT_IN_STATUS_KEY) == undefined) {
            let result = await (0, consent_dialog_1.showConsentDialog)({
                incentive: incentive,
                acceptButtonText: "Yes, accept",
                declineButtonText: "Later",
                parentWindow: window
            });
            (0, storage_helpers_1.setLocalStorage)(OPT_IN_STATUS_KEY, result);
        }
        else {
            logger_1.Logger.log("Consent already provided");
        }
    }
    /**
     * Shows the consent settings dialog.
     * @param window - The Electron BrowserWindow instance.
     * @returns Promise<void>
     */
    async showConsentSettings(window) {
        await (0, consent_setttings_1.showConsentSettings)({
            initiallyOptedIn: this.getOptInStatus(),
            nodeId: this.nodeId,
            parentWindow: window,
            onOptIn: async () => {
                await this.optIn();
                await this.wsManager.initialize(this.nodeId);
            },
            onOptOut: async () => {
                await this.optOut();
            }
        });
    }
    /**
     * Gets the current opt-in status.
     * @returns boolean - Returns true if the user is opted in, false otherwise.
     */
    getOptInStatus() {
        const status = (0, storage_helpers_1.getLocalStorage)(OPT_IN_STATUS_KEY);
        return !!status;
    }
    /**
     * Opts in to the service and initializes WebSocket if not already initialized.
     * @returns Promise<void>
     */
    async optIn() {
        (0, storage_helpers_1.setLocalStorage)(OPT_IN_STATUS_KEY, true);
        logger_1.Logger.log("User opted in");
    }
    /**
     * Opts out of the service and disconnects WebSocket if connected.
     * @returns Promise<void>
     */
    async optOut() {
        (0, storage_helpers_1.setLocalStorage)(OPT_IN_STATUS_KEY, false);
        this.wsManager.disconnect();
        logger_1.Logger.log("User opted out");
    }
}
exports.default = MellowtelSDK;
