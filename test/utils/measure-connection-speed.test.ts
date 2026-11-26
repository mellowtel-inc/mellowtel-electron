import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// In-memory stand-in for electron-store.
const store: Record<string, unknown> = {};
vi.mock("../../src/storage/storage-helpers", () => ({
  getLocalStorage: (k: string) => store[k],
  setLocalStorage: (k: string, v: unknown) => {
    store[k] = v;
  },
}));

// Simulated link: Electron's net.request, where every stream gets an equal share
// of `linkMbps`, delivered every 1 ms after a 20 ms connect delay.
let linkMbps = 0;
let statusCode = 200;
vi.mock("electron", () => ({
  app: { isReady: () => true },
  net: {
    request: () => {
      const req: any = new EventEmitter();
      let timer: NodeJS.Timeout | undefined;
      req.end = () => {
        const res: any = new EventEmitter();
        res.statusCode = statusCode;
        setTimeout(() => {
          req.emit("response", res);
          const perStreamBytesPerMs = (linkMbps * 1e6) / 8 / 1000 / 4;
          let sent = 0;
          let carry = 0;
          timer = setInterval(() => {
            carry += perStreamBytesPerMs;
            const n = Math.floor(carry);
            carry -= n;
            if (n > 0) {
              res.emit("data", Buffer.alloc(n));
              sent += n;
            }
            if (sent >= 5 * 1024 * 1024) {
              clearInterval(timer);
              res.emit("end");
            }
          }, 1);
        }, 20);
      };
      req.abort = () => {
        clearInterval(timer);
        req.emit("abort");
      };
      return req;
    },
  },
}));

async function measure(mbps: number): Promise<number> {
  vi.resetModules();
  for (const k of Object.keys(store)) delete store[k];
  linkMbps = mbps;
  const m = await import("../../src/utils/measure-connection-speed");
  m.refreshSpeedInBackground();
  await vi.advanceTimersByTimeAsync(11_000); // past SPEED_TEST_TIMEOUT_MS
  return m.getCachedSpeed();
}

beforeEach(() => {
  vi.useFakeTimers();
  statusCode = 200;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("speed test reading vs link speed", () => {
  // From ~175 Mbps the 10 MiB cap is reached during the 500 ms warmup or just after it;
  // that used to report 0. 150-200 covers the boundary.
  for (const mbps of [35, 100, 150, 160, 170, 175, 180, 190, 200, 300, 500, 1000]) {
    it(`${mbps} Mbps link is reported within 10%`, async () => {
      const reported = await measure(mbps);
      expect(reported).toBeGreaterThan(mbps * 0.9);
      expect(reported).toBeLessThan(mbps * 1.1);
    });
  }

  it("an error status is not measured and nothing is cached", async () => {
    statusCode = 503;
    expect(await measure(500)).toBe(0);
    expect(store["mellowtel_speed_test_cache"]).toBeUndefined();
  });
});
