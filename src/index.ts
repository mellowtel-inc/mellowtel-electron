import { getOrGenerateIdentifier } from "./utils/identity-helpers";
import { Logger } from "./logger/logger";
import { WebSocketManager } from "./websockets";
import { getLocalStorage, setLocalStorage } from "./storage/storage-helpers";
import { BrowserWindow } from 'electron'
import { showConsentSettings } from "./dialogs/consent-setttings";
import { showConsentDialog } from "./dialogs/consent-dialog";

const OPT_IN_STATUS_KEY = "mellowtel_opt_in_status";

interface MellowtelSDKOptions {
  disableLogs: boolean
}

export default class MellowtelSDK {
  private configurationKey: string;
  private nodeId: string;
  private options?: MellowtelSDKOptions;
  private disableLogs: boolean = true;
  private wsManager: WebSocketManager = WebSocketManager.getInstance();

  /**
   * Creates an instance of MellowtelSDK.
   * @param publishableKey - The publishable key for the SDK.
   * @param options - Optional configuration options.
   */
  constructor(publishableKey: string, options?: MellowtelSDKOptions) {
    this.configurationKey = publishableKey;
    this.options = options;
    this.disableLogs = options?.disableLogs !== undefined ? options.disableLogs : true;
    Logger.disableLogs = this.disableLogs;
    this.nodeId = getOrGenerateIdentifier(publishableKey);
    Logger.log(this.nodeId);
  }

  /**
   * Initializes the SDK.
   * @returns Promise<void>
   * @throws Error if the publishableKey is undefined, null, or empty.
   */
  public async init(): Promise<void> {
    if (!this.configurationKey) {
      throw new Error("publishableKey is undefined, null, or empty");
    }

    if (!this.getOptInStatus()) {
      Logger.log("User is not opted in. WebSocket connection will not be established.");
      return;
    }

    await this.wsManager.initialize(this.nodeId);
    Logger.log("Mellowtel SDK initialized");
  }

  /**
   * Requests user consent.
   * @param window - The Electron BrowserWindow instance.
   * @param incentive - The incentive to show in the consent dialog.
   * @returns Promise<void>
   */
  public async requestConsent(window: BrowserWindow, incentive: string): Promise<void> {
    if (getLocalStorage(OPT_IN_STATUS_KEY) == undefined) {
      let result = await showConsentDialog({
        incentive: incentive,
        acceptButtonText: "Yes, accept",
        declineButtonText: "Later",
        parentWindow: window!
      });
      setLocalStorage(OPT_IN_STATUS_KEY, result);
    } else {
      Logger.log("Consent already provided");
    }
  }

  /**
   * Shows the consent settings dialog.
   * @param window - The Electron BrowserWindow instance.
   * @returns Promise<void>
   */
  public async showConsentSettings(window: BrowserWindow): Promise<void> {
    await showConsentSettings({
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
  public getOptInStatus(): boolean {
    const status = getLocalStorage(OPT_IN_STATUS_KEY);
    return !!status;
  }

  /**
   * Opts in to the service and initializes WebSocket if not already initialized.
   * @returns Promise<void>
   */
  public async optIn(): Promise<void> {
    setLocalStorage(OPT_IN_STATUS_KEY, true);
    Logger.log("User opted in");
  }

  /**
   * Opts out of the service and disconnects WebSocket if connected.
   * @returns Promise<void>
   */
  public async optOut(): Promise<void> {
    setLocalStorage(OPT_IN_STATUS_KEY, false);
    this.wsManager.disconnect();
    Logger.log("User opted out");
  }
}