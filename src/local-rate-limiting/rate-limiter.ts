import { getLocalStorage, setLocalStorage } from "../storage/storage-helpers";
import { Logger } from "../logger/logger";
import { MAX_DAILY_RATE as DEFAULT_MAX_DAILY_RATE } from "../constants";

export class RateLimiter {
  private static MAX_DAILY_RATE: number = DEFAULT_MAX_DAILY_RATE;

  private static getRateLimitData(): { timestamp: number; count: number } {
    const timestamp = getLocalStorage("timestamp_m");
    const count = getLocalStorage("count_m");
    return {
      timestamp: timestamp ? parseInt(timestamp) : 0,
      count: count ? parseInt(count) : 0,
    };
  }

  private static setRateLimitData(timestamp: number, count: number) {
    setLocalStorage("timestamp_m", timestamp);
    setLocalStorage("count_m", count);
  }
  
  static shouldContinue(increment: boolean = true): boolean {
    const now = Date.now();
    const { timestamp, count } = this.getRateLimitData();

    if (timestamp === 0 || now - timestamp >= 24 * 60 * 60 * 1000) {
      // Reset the rate limit data if no timestamp or 24 hours have passed
      this.setRateLimitData(now, increment ? 1 : 0);
      return true;
    }

    if (count < this.MAX_DAILY_RATE) {
      // Increment the count if within the limit
      if (increment) {
        this.setRateLimitData(timestamp, count + 1);
      }
      return true;
    } else {
      // Rate limit reached
      Logger.log(`[]: RATE LIMIT REACHED`);
      return false;
    }
  }
}