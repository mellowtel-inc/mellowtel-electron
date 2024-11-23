import { getOrGenerateIdentifier } from "./utils/identity-helpers";
import { Logger } from "./logger/logger";
import { RateLimiter } from "./local-rate-limiting/rate-limiter";
import { MAX_DAILY_RATE as DEFAULT_MAX_DAILY_RATE, VERSION } from "./constants";
import { WebSocketManager } from "./websockets";
import { getLocalStorage, setLocalStorage } from "./storage/storage-helpers";

const OPT_IN_STATUS_KEY = "mellowtel_opt_in_status";

export default class MellowtelSDK {
  private publishableKey: string;
  private options?: any;
  private disableLogs: boolean = true;
  private MAX_DAILY_RATE: number = DEFAULT_MAX_DAILY_RATE;
  private wsManager = WebSocketManager.getInstance();

  constructor(publishableKey: string, options?: any) {
    this.publishableKey = publishableKey;
    this.options = options;
    this.disableLogs = options?.disableLogs !== undefined ? options.disableLogs : true;
    this.MAX_DAILY_RATE = options?.MAX_DAILY_RATE || DEFAULT_MAX_DAILY_RATE;
    RateLimiter.MAX_DAILY_RATE = this.MAX_DAILY_RATE;
    Logger.disableLogs = this.disableLogs;
  }

  public async init(): Promise<void> {

    getLocalStorage('test_key')
    if (!this.publishableKey) {
      throw new Error("publishableKey is undefined, null, or empty");
    }
    
    if (!this.getOptInStatus()) {
      Logger.log("User is not opted in. WebSocket connection will not be established.");
      return;
    }

    let identifier = getOrGenerateIdentifier(this.publishableKey);
    Logger.log(identifier);
    
    await this.wsManager.initialize(identifier);
    Logger.log("Mellowtel SDK initialized");
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
    await setLocalStorage(OPT_IN_STATUS_KEY, true);
    Logger.log("User opted in");
  }

  /**
   * Opt out of the service and disconnect WebSocket if connected
   * @returns Promise<void>
   */
  public async optOut(): Promise<void> {
    await setLocalStorage(OPT_IN_STATUS_KEY, false);
    Logger.log("User opted out");
  }
}
