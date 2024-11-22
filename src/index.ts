import { getOrGenerateIdentifier } from "./utils/identity-helpers";
import { Logger } from "./logger/logger";
import { RateLimiter } from "./local-rate-limiting/rate-limiter";
import { MAX_DAILY_RATE as DEFAULT_MAX_DAILY_RATE, VERSION } from "./constants";

export default class MellowtelSDK {
  private publishableKey: string;
  private options?: any;
  private disableLogs: boolean = true;
  private MAX_DAILY_RATE: number = DEFAULT_MAX_DAILY_RATE;

  constructor(publishableKey: string, options?: any) {
    this.publishableKey = publishableKey;
    this.options = options;
    this.disableLogs = options?.disableLogs !== undefined ? options.disableLogs : true;
    this.MAX_DAILY_RATE = options?.MAX_DAILY_RATE || DEFAULT_MAX_DAILY_RATE;
    RateLimiter.MAX_DAILY_RATE = this.MAX_DAILY_RATE;
    Logger.disableLogs = this.disableLogs;
  }

  public async init(): Promise<void> {
    if (!this.publishableKey) {
      throw new Error("publishableKey is undefined, null, or empty");
    }
    await getOrGenerateIdentifier(this.publishableKey);
    Logger.log("Mellowtel SDK initialized");
  }

  public getVersion(): string {
    return VERSION;
  }
}