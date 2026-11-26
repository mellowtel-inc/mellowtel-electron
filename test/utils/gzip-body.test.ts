import { describe, it, expect } from "vitest";
import { gunzipSync } from "node:zlib";

import { describeEncoding, gzipBody } from "../../src/utils/gzip-body";

describe("gzipBody", () => {
  it("gzips a body of at least 1024 bytes and round-trips", async () => {
    const json = JSON.stringify({ content: "a".repeat(1024) });
    expect(Buffer.byteLength(json)).toBeGreaterThanOrEqual(1024);

    const encoded = await gzipBody(json, "text/plain", true);

    expect(encoded.body).toBeInstanceOf(Uint8Array);
    expect(gunzipSync(encoded.body as Uint8Array).toString("utf8")).toBe(json);
    expect(encoded.headers).toEqual({ "Content-Type": "text/plain", "Content-Encoding": "gzip" });
    expect(encoded.gzipped).toBe(true);
    expect(encoded.rawBytes).toBe(Buffer.byteLength(json));
    expect(encoded.sentBytes).toBe((encoded.body as Uint8Array).byteLength);
    expect(encoded.sentBytes).toBeLessThan(encoded.rawBytes);
  });

  it("gzips a body of exactly 1024 bytes", async () => {
    const json = "x".repeat(1024);

    const encoded = await gzipBody(json, "text/plain", true);

    expect(encoded.body).toBeInstanceOf(Uint8Array);
    expect(encoded.headers["Content-Encoding"]).toBe("gzip");
    expect(gunzipSync(encoded.body as Uint8Array).toString("utf8")).toBe(json);
  });

  it("leaves a body under 1024 bytes plain", async () => {
    const json = "x".repeat(1023);

    const encoded = await gzipBody(json, "text/plain", true);

    expect(encoded.body).toBe(json);
    expect(encoded.headers).toEqual({ "Content-Type": "text/plain" });
    expect(encoded.gzipped).toBe(false);
    expect(encoded.sentBytes).toBe(1023);
  });

  it("leaves a large body plain when disabled", async () => {
    const json = JSON.stringify({ content: "a".repeat(5000) });

    const encoded = await gzipBody(json, "text/plain", false);

    expect(encoded.body).toBe(json);
    expect(encoded.headers).toEqual({ "Content-Type": "text/plain" });
    expect(encoded.gzipped).toBe(false);
  });

  it("preserves application/json", async () => {
    const json = JSON.stringify({ capture: "b".repeat(1100) });

    const encoded = await gzipBody(json, "application/json", true);

    expect(encoded.headers).toEqual({ "Content-Type": "application/json", "Content-Encoding": "gzip" });
    expect(gunzipSync(encoded.body as Uint8Array).toString("utf8")).toBe(json);
  });

  it("measures multi-byte characters in bytes", async () => {
    // 340 chars, 1020 UTF-8 bytes plus quotes and braces: over the threshold in bytes,
    // well under it in string length.
    const json = JSON.stringify({ text: "雪".repeat(340) });
    expect(json.length).toBeLessThan(1024);
    expect(Buffer.byteLength(json)).toBeGreaterThanOrEqual(1024);

    const encoded = await gzipBody(json, "application/json", true);

    expect(encoded.gzipped).toBe(true);
    expect(gunzipSync(encoded.body as Uint8Array)).toEqual(Buffer.from(json, "utf8"));
  });
});

describe("describeEncoding", () => {
  it("names the reason a body stayed plain", async () => {
    expect(describeEncoding(await gzipBody("{}", "text/plain", false), false)).toBe("plain 2 bytes (gzip off)");
    expect(describeEncoding(await gzipBody("{}", "text/plain", true), true)).toBe(
      "plain 2 bytes (under gzip threshold)"
    );
  });

  it("reports before and after sizes when gzipped", async () => {
    const encoded = await gzipBody("x".repeat(2000), "text/plain", true);
    expect(describeEncoding(encoded, true)).toBe(`gzip 2000 -> ${encoded.sentBytes} bytes`);
  });
});
