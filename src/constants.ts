export const VERSION: string = "700.0.36";
export let MAX_DAILY_RATE: number = 15000;
export const REFRESH_INTERVAL: number = 1000 * 60 * 60 * 24; // 24 hours

export const APPROVAL_API_URL = "https://api.mellow.tel/approval";
export const APPROVAL_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes
export const APPROVAL_RETRY_DELAYS: number[] = [
  30 * 1000, // 30 seconds
  60 * 1000, // 1 minute
  5 * 60 * 1000, // 5 minutes
  10 * 60 * 1000, // 10 minutes
  20 * 60 * 1000, // 20 minutes
  60 * 60 * 1000, // 1 hour
];