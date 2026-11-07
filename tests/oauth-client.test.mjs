import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { audienceOf, classifyProbe, scanCandidates } from "../lib/oauth-client.mjs";

// 格式合法但完全虚构的凭据
const secret = (c) => `GOCSPX-${c.repeat(28)}`;
const id = (n, c, digits = 12) => `${String(n).padStart(digits, "1")}-${c.repeat(32)}.apps.googleusercontent.com`;

function withBinary(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "agy-bridge-bin-"));
  try {
    const path = join(dir, "agy");
    writeFileSync(path, content);
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("scanCandidates finds credentials even when Go strings are packed back to back", () => {
  const blob = Buffer.concat([
    Buffer.from("noise\0session_id"),
    Buffer.from(secret("a") + "error_code" + secret("b") + "x"),
    Buffer.alloc(64, 0),
    Buffer.from("prefix" + id(1, "a") + "key" + id(2, "b", 13) + "tail"),
  ]);
  const { ids, secrets } = withBinary(blob, scanCandidates);
  assert.deepEqual(secrets, [secret("a"), secret("b")]);
  assert.deepEqual(ids, [id(1, "a"), id(2, "b", 13)], "12- and 13-digit project numbers are both kept whole");
});

test("scanCandidates deduplicates and ignores near-miss formats", () => {
  const blob = Buffer.from([
    secret("a"), secret("a"),
    "GOCSPX-" + "z".repeat(10), // 太短
    `${"9".repeat(8)}-${"a".repeat(32)}.apps.googleusercontent.com`, // 数字位数太少
    id(3, "c"), id(3, "c"),
  ].join("\0"));
  const { ids, secrets } = withBinary(blob, scanCandidates);
  assert.deepEqual(secrets, [secret("a")]);
  assert.deepEqual(ids, [id(3, "c")]);
});

test("scanCandidates catches a match that straddles a chunk boundary exactly once", () => {
  const CH = 16 * 1024 * 1024;
  const target = secret("q");
  const blob = Buffer.alloc(CH + 4096, 0x20);
  blob.write(target, CH - 10, "latin1"); // 起点在第一块末尾 10 字节处，跨块
  blob.write(secret("r"), CH + 100, "latin1");
  const { secrets } = withBinary(blob, scanCandidates);
  assert.deepEqual(secrets, [target, secret("r")]);
});

test("audienceOf reads the issuing client from an id_token, offline", () => {
  const jwt = (payload) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
  assert.equal(audienceOf(jwt({ aud: id(7, "d"), email: "x@example.com" })), id(7, "d"));
  assert.equal(audienceOf(jwt({ aud: [id(8, "e"), "other"] })), id(8, "e"));
  assert.equal(audienceOf(jwt({ aud: "not-a-google-client" })), null);
  assert.equal(audienceOf("garbage"), null);
  assert.equal(audienceOf(null), null);
});

test("classifyProbe: invalid_grant means the pair is right, invalid_client means wrong", () => {
  assert.equal(classifyProbe(400, JSON.stringify({ error: "invalid_grant", error_description: "Bad Request" })), "match");
  assert.equal(classifyProbe(401, JSON.stringify({ error: "invalid_client", error_description: "Unauthorized" })), "mismatch");
  assert.equal(classifyProbe(401, JSON.stringify({ error: "unauthorized_client" })), "mismatch");
  assert.equal(classifyProbe(503, "upstream error"), "unknown");
  assert.equal(classifyProbe(429, "{}"), "unknown");
  assert.equal(classifyProbe(400, "not json"), "unknown");
});
