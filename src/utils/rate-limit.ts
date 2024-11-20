import { MellowtelStore } from '../store';
import { Logger } from './logger';
import { REFRESH_INTERVAL } from '../constants';

export class RateLimiter {
  private static store = MellowtelStore.getInstance();
  static MAX_DAILY_RATE: number;

  static async getRateLimitData(): Promise<{
    timestamp: number;
    count: number;
  }> {
    const rateLimit = this.store.getRateLimit();
    return {
      timestamp: rateLimit.timestamp,
      count: rateLimit.count
    };
  }

  static async setRateLimitData(timestamp: number, count: number): Promise<void> {
    this.store.updateRateLimit(count, count >= this.MAX_DAILY_RATE);
  }

  static async resetRateLimitData(now: number, addToCount: boolean = false): Promise<void> {
    await this.setRateLimitData(now, addToCount ? 1 : 0);
  }

  static async getIfRateLimitReached(): Promise<boolean> {
    const rateLimit = this.store.getRateLimit();
    return rateLimit.isLimited;
  }

  static calculateElapsedTime(now: number, timestamp: number): number {
    return now - timestamp;
  }

  static async checkRateLimit(increaseCount = true): Promise<{
    shouldContinue: boolean;
    isLastCount: boolean;
    requestsCount: number;
  }> {
    const now = Date.now();
    const { timestamp, count } = await this.getRateLimitData();

    if (!timestamp) {
      Logger.log('[🕒]: Initial setup - setting timestamp and count');
      await this.setRateLimitData(now, 1);
      return { shouldContinue: true, isLastCount: false, requestsCount: 0 };
    }

    const elapsedTime = this.calculateElapsedTime(now, timestamp);
    if (elapsedTime > REFRESH_INTERVAL) {
      Logger.log('[🕒]: Refresh interval elapsed - resetting count');
      await this.resetRateLimitData(now, true);
      return { shouldContinue: true, isLastCount: false, requestsCount: 0 };
    }

    if (increaseCount) {
      await this.setRateLimitData(timestamp, count + 1);
    }

    Logger.log(`[🕒]: Count: ${count}, Max: ${this.MAX_DAILY_RATE}`);
    
    if (count <= this.MAX_DAILY_RATE) {
      return {
        shouldContinue: true,
        isLastCount: count === this.MAX_DAILY_RATE,
        requestsCount: count
      };
    }

    Logger.log('[🕒]: Rate limit reached');
    return {
      shouldContinue: false,
      isLastCount: false,
      requestsCount: count
    };
  }

  static setMaxDailyRate(rate: number) {
    this.MAX_DAILY_RATE = rate;
  }

  static getMaxDailyRate(): number {
    return this.MAX_DAILY_RATE;
  }
}