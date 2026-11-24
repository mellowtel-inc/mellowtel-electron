import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { gunzipSync } from "node:zlib";

import { gzipBody } from "../../src/utils/gzip-body";

describe("gzipBody", () => {
  it("gzips a body of at least 1024 bytes and round-trips", async () => {
    const json = JSON.stringify({ content: "a".repeat(1024) });
    assert.ok(Buffer.byteLength(json) >= 1024);

    const encoded = await gzipBody(json, "text/plain");

    assert.ok(encoded.body instanceof Uint8Array);
    assert.equal(gunzipSync(encoded.body).toString("utf8"), json);
    assert.deepEqual(encoded.headers, {
      "Content-Type": "text/plain",
      "Content-Encoding": "gzip",
    });
  });

  it("gzips a body of exactly 1024 bytes", async () => {
    const json = "x".repeat(1024);

    const encoded = await gzipBody(json, "text/plain");

    assert.ok(encoded.body instanceof Uint8Array);
    assert.equal(encoded.headers["Content-Encoding"], "gzip");
    assert.equal(gunzipSync(encoded.body).toString("utf8"), json);
  });

  it("leaves a body under 1024 bytes plain", async () => {
    const json = "x".repeat(1023);
    assert.equal(Buffer.byteLength(json), 1023);

    const encoded = await gzipBody(json, "text/plain");

    assert.equal(encoded.body, json);
    assert.deepEqual(encoded.headers, { "Content-Type": "text/plain" });
  });

  it("preserves application/json", async () => {
    const json = JSON.stringify({ capture: "b".repeat(1100) });

    const encoded = await gzipBody(json, "application/json");

    assert.equal(encoded.headers["Content-Type"], "application/json");
    assert.equal(encoded.headers["Content-Encoding"], "gzip");
    assert.ok(encoded.body instanceof Uint8Array);
    assert.equal(gunzipSync(encoded.body).toString("utf8"), json);
  });

  it("round-trips multi-byte characters on bytes", async () => {
    const json = JSON.stringify({ text: "雪".repeat(400) });
    assert.ok(Buffer.byteLength(json) >= 1024);
    assert.notEqual(json.length, Buffer.byteLength(json));

    const encoded = await gzipBody(json, "application/json");

    assert.ok(encoded.body instanceof Uint8Array);
    assert.deepEqual(gunzipSync(encoded.body), Buffer.from(json, "utf8"));
  });
});
