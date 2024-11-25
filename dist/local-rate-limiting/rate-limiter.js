"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiter = void 0;
const storage_helpers_1 = require("../storage/storage-helpers");
const logger_1 = require("../logger/logger");
const constants_1 = require("../utils/constants");
class RateLimiter {
    static getRateLimitData() {
        const timestamp = (0, storage_helpers_1.getLocalStorage)("timestamp_m");
        const count = (0, storage_helpers_1.getLocalStorage)("count_m");
        return {
            timestamp: timestamp ? parseInt(timestamp) : 0,
            count: count ? parseInt(count) : 0,
        };
    }
    static setRateLimitData(timestamp, count) {
        (0, storage_helpers_1.setLocalStorage)("timestamp_m", timestamp);
        (0, storage_helpers_1.setLocalStorage)("count_m", count);
    }
    static shouldContinue(increment = true) {
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
        }
        else {
            // Rate limit reached
            logger_1.Logger.log(`[]: RATE LIMIT REACHED`);
            return false;
        }
    }
}
exports.RateLimiter = RateLimiter;
RateLimiter.MAX_DAILY_RATE = constants_1.MAX_DAILY_RATE;
