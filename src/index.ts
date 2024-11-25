import { getOrGenerateIdentifier } from "./utils/identity-helpers";
import { Logger } from "./logger/logger";
import { WebSocketManager } from "./websockets";
import { getLocalStorage, setLocalStorage } from "./storage/storage-helpers";
import { BrowserWindow } from 'electron'
import { showConsentSettings } from "./consent/consent-setttings";
import { showConsentDialog } from "./consent/consent-dialog";

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
   * @param configurationKey - Your configuration key for the SDK received via email.
   * @param options - Optional configuration options.
   */
  constructor(configurationKey: string, options?: MellowtelSDKOptions) {
    this.configurationKey = configurationKey;
    this.options = options;
    this.disableLogs = options?.disableLogs !== undefined ? options.disableLogs : true;
    Logger.disableLogs = this.disableLogs;
    this.nodeId = getOrGenerateIdentifier(configurationKey);
    Logger.log(this.nodeId);
  }

  /**
   * Signals Mellowtel to start operating if consent is provided.
   * 
   * @returns Promise<void>
   * @throws Error if the configuration key is empty.
   */
  public async init(): Promise<void> {
    if (!this.configurationKey) {
      throw new Error("configurationKey is undefined, null, or empty");
    }

    if (!this.getOptInStatus()) {
      Logger.log("User is not opted in. WebSocket connection will not be established.");
      return;
    }

    await this.wsManager.initialize(this.nodeId);
    Logger.log("Mellowtel SDK initialized");
  }

  /**
   * Requests user consent by showing a dialog explaining 
   * about Mellowtel and the incentive for providing consent.
   * 
   * Only shown once until consent has been provided or denied.
   * 
   * @param window - The Electron BrowserWindow instance.
   * @param incentive - The incentive to show in the consent dialog.
   * @returns Promise<boolean | undefined> - Returns true if the user provided consent, false if denied, and undefined if consent was already provided.
   */
  public async requestConsent(
    window: BrowserWindow,
    incentive: string,
  ): Promise<boolean | undefined> {
    if (getLocalStorage(OPT_IN_STATUS_KEY) == undefined) {
      let result = await showConsentDialog({
        incentive: incentive,
        acceptButtonText: "Yes, accept",
        declineButtonText: "Later",
        parentWindow: window!
      });

      setLocalStorage(OPT_IN_STATUS_KEY, result);
      return result;
    } else {
      Logger.log("Consent already provided");
      return undefined;
    }
  }

  /**
   * Shows the consent settings dialog for the user to manage their consent.
   * 
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
   * Manually opts in the user to the service from your own interface.
   * @returns Promise<void>
   */
  public async optIn(): Promise<void> {
    setLocalStorage(OPT_IN_STATUS_KEY, true);
    Logger.log("User opted in");
  }

  /**
   * Manually opts out the user from the service from your own interface. Disconnects WebSocket if connected.
   * @returns Promise<void>
   */
  public async optOut(): Promise<void> {
    setLocalStorage(OPT_IN_STATUS_KEY, false);
    this.wsManager.disconnect();
    Logger.log("User opted out");
  }
}