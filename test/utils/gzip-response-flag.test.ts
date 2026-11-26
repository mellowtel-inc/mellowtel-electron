import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import type { BrowserWindow } from "electron";

// identity-helpers pulls in electron-store, which needs a running Electron app.
vi.mock("../../src/utils/identity-helpers", () => ({ getIdentifier: () => "mllwtl_test_node" }));

import { DataRequest } from "../../src/utils/data-request";
import { saveCrawl } from "../../src/utils/put-to-signed";
import { collectAndSendCaptures, parseBurkeObject } from "../../src/utils/meucci-helpers";

type Sent = { url: string; headers: Record<string, string>; body: string | Uint8Array };

let sent: Sent[];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: init.body as string | Uint8Array });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** What the server sees after its gunzip plugin runs. */
function decode(req: Sent): string {
  if (req.headers["Content-Encoding"] === "gzip") {
    return gunzipSync(req.body as Uint8Array).toString("utf8");
  }
  return req.body as string;
}

function job(extra: Record<string, unknown> = {}): DataRequest {
  return DataRequest.fromJson({
    url: "https://example.com/",
    orgId: "org_1",
    recordID: "rec_1",
    saveHtml: true,
    save_html_endpoint: "https://sink.test/save",
    ...extra,
  });
}

describe("DataRequest.gzipResponse parsing", () => {
  it.each([
    ["missing", {}, false],
    ["true", { gzipResponse: true }, true],
    ["false", { gzipResponse: false }, false],
    ['"true" (same as other optional flags)', { gzipResponse: "true" }, true],
    ["1 (same as other optional flags)", { gzipResponse: 1 }, true],
    ["an unrelated string", { gzipResponse: "yes" }, false],
    ["null", { gzipResponse: null }, false],
    ["an object", { gzipResponse: {} }, false],
  ])("is %s -> %s", (_label, extra, expected) => {
    expect(job(extra).gzipResponse).toBe(expected);
  });

  it("defaults to false when built without the field", () => {
    expect(new DataRequest({ url: "https://example.com/", orgId: "o", recordID: "r" }).gzipResponse).toBe(false);
  });
});

describe("saveCrawl", () => {
  const bigHtml = "<p>" + "hello world ".repeat(500) + "</p>";

  it("sends a plain body with no Content-Encoding when the flag is off", async () => {
    await saveCrawl(job(), bigHtml, undefined, false, "");

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://sink.test/save");
    expect(sent[0].headers).toEqual({ "Content-Type": "text/plain" });
    expect(typeof sent[0].body).toBe("string");
    expect(JSON.parse(sent[0].body as string).content).toBe(bigHtml);
  });

  it("sends a plain body when the flag is on but the body is under 1 KiB", async () => {
    await saveCrawl(job({ gzipResponse: true, saveHtml: false }), "", undefined, false, "");

    expect(Buffer.byteLength(sent[0].body as string)).toBeLessThan(1024);
    expect(sent[0].headers).toEqual({ "Content-Type": "text/plain" });
    expect(typeof sent[0].body).toBe("string");
  });

  it("gzips a body of 1 KiB or more when the flag is on, and it parses to the same JSON", async () => {
    await saveCrawl(job(), bigHtml, undefined, false, "");
    const plain = JSON.parse(decode(sent[0]));

    await saveCrawl(job({ gzipResponse: true }), bigHtml, undefined, false, "");
    const gz = sent[1];

    expect(gz.headers).toEqual({ "Content-Type": "text/plain", "Content-Encoding": "gzip" });
    expect(gz.body).toBeInstanceOf(Uint8Array);
    const parsed = JSON.parse(decode(gz));
    // requestMessageInfo echoes the job JSON, which differs by the flag itself.
    expect({ ...parsed, requestMessageInfo: undefined }).toEqual({ ...plain, requestMessageInfo: undefined });
    expect(parsed.content).toBe(bigHtml);
  });
});

describe("Meucci capture sink", () => {
  const burke = JSON.stringify({ endpoint: "https://captures.test/ingest" });

  function fakeWindow(captures: unknown[]): BrowserWindow {
    return {
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async (code: string) =>
          code.includes("__MEUCCI_PENDING__") ? 0 : JSON.stringify({ captures, stats: null }),
      },
    } as unknown as BrowserWindow;
  }

  it("carries the job flag into the capture config, default off", () => {
    expect(parseBurkeObject(burke, "rec_1")?.gzip_response).toBe(false);
    expect(parseBurkeObject(burke, "rec_1", false)?.gzip_response).toBe(false);
    expect(parseBurkeObject(burke, "rec_1", true)?.gzip_response).toBe(true);
  });

  it("sends plain captures with no Content-Encoding when the flag is off", async () => {
    const config = parseBurkeObject(burke, "rec_1", false)!;
    const big = { id: "c1", body: "x".repeat(4000) };

    expect(await collectAndSendCaptures(fakeWindow([big]), config, 0)).toBe(1);

    expect(sent[0].url).toBe("https://captures.test/ingest");
    expect(sent[0].headers).toEqual({ "Content-Type": "application/json" });
    expect(sent[0].body).toBe(JSON.stringify(big));
  });

  it("gzips only the captures of 1 KiB or more when the flag is on", async () => {
    const config = parseBurkeObject(burke, "rec_1", true)!;
    const small = { id: "c1", body: "tiny" };
    const big = { id: "c2", body: "x".repeat(4000) };

    expect(await collectAndSendCaptures(fakeWindow([small, big]), config, 0)).toBe(2);

    expect(sent[0].headers).toEqual({ "Content-Type": "application/json" });
    expect(sent[0].body).toBe(JSON.stringify(small));

    expect(sent[1].headers).toEqual({ "Content-Type": "application/json", "Content-Encoding": "gzip" });
    expect(sent[1].body).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(decode(sent[1]))).toEqual(big);
  });
});
