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
// Connection speed test (see utils/measure-connection-speed.ts).
// Measured with Electron's built-in `net` module against Cloudflare's public
// download endpoint. The test is best-effort: every failure resolves to
// SPEED_TEST_FALLBACK and never interrupts the WebSocket flow.
export const SPEED_TEST_URL: string = "https://speed.cloudflare.com/__down";
export const SPEED_TEST_STREAMS: number = 4;
export const SPEED_TEST_BYTES_PER_REQ: number = 5 * 1024 * 1024; // requested per stream; aborted early
export const SPEED_TEST_MAX_BYTES: number = 10 * 1024 * 1024; // hard ceiling across all streams
export const SPEED_TEST_MAX_DURATION_MS: number = 5000; // measurement window after warmup
export const SPEED_TEST_TIMEOUT_MS: number = 10000; // absolute wall clock
export const SPEED_TEST_WARMUP_MS: number = 500; // discarded, excludes TCP slow start
export const SPEED_TEST_CACHE_TTL_MS: number = 60 * 60 * 1000; // 1 hour
export const SPEED_TEST_MAX_PER_DAY: number = 6;
export const SPEED_TEST_FALLBACK: number = 0;
