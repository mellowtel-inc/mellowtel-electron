import { getOrGenerateIdentifier } from "./utils/identity-helpers";
import { Logger } from "./logger/logger";
import { RateLimiter } from "./local-rate-limiting/rate-limiter";
import { MAX_DAILY_RATE as DEFAULT_MAX_DAILY_RATE, VERSION } from "./constants";
import { WebSocketManager } from "./websockets";
import { getLocalStorage, setLocalStorage } from "./storage/storage-helpers";
import { BrowserWindow } from 'electron'
import { showConsentSettings } from "./consent-setttings";
import { showConsentDialog } from "./consent-dialog";
const OPT_IN_STATUS_KEY = "mellowtel_opt_in_status";

export default class MellowtelSDK {
  private configurationKey: string;
  private nodeId: string;
  private options?: any;
  private disableLogs: boolean = true;
  private MAX_DAILY_RATE: number = DEFAULT_MAX_DAILY_RATE;
  private wsManager: WebSocketManager = WebSocketManager.getInstance();

  constructor(publishableKey: string, options?: any) {
    this.configurationKey = publishableKey;
    this.options = options;
    this.disableLogs = options?.disableLogs !== undefined ? options.disableLogs : true;
    this.MAX_DAILY_RATE = options?.MAX_DAILY_RATE || DEFAULT_MAX_DAILY_RATE;
    RateLimiter.MAX_DAILY_RATE = this.MAX_DAILY_RATE;
    Logger.disableLogs = this.disableLogs;
    this.nodeId = getOrGenerateIdentifier(publishableKey)
    Logger.log(this.nodeId);
  }

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

  public async requestConsent(window: BrowserWindow, incentive: string): Promise<void> {
    // if(!this.getOptInStatus()){
    let result = await showConsentDialog({
      incentive: incentive,
      acceptButtonText: "Yes, accept",
      declineButtonText: "Later",
      parentWindow: window!
    });

    if (result) {
      await this.optIn();
    } else {
      await this.optOut();
    }
    // } else {
    //   Logger.log("Consent already provided");
    // }
  }


  public async showConsentSettings(window: BrowserWindow): Promise<void> {
    await showConsentSettings({
      initiallyOptedIn: this.getOptInStatus(),
      nodeId: this.nodeId,
      parentWindow: window,
      onOptIn: async () => {
        await this.optIn();
      },
      onOptOut: async () => {
        await this.optOut();
      }
    });
  }

  public getVersion(): string {
    return VERSION;
  }

  /**
   * Get the current opt-in status
   * @returns Promise<boolean> - Returns true if user is opted in, false otherwise
   */
  public getOptInStatus(): boolean {
    const status = getLocalStorage(OPT_IN_STATUS_KEY);
    return !!status;
  }

  /**
   * Opt in to the service and initialize WebSocket if not already initialized
   * @returns Promise<void>
   */
  public async optIn(): Promise<void> {
    setLocalStorage(OPT_IN_STATUS_KEY, true);
    await this.wsManager.initialize(this.nodeId)
    Logger.log("User opted in");
  }

  /**
   * Opt out of the service and disconnect WebSocket if connected
   * @returns Promise<void>
   */
  public async optOut(): Promise<void> {
    setLocalStorage(OPT_IN_STATUS_KEY, false);
    this.wsManager.disconnect();
    Logger.log("User opted out");
  }
}
