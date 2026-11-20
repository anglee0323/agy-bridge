/**
 * 拦住 agy 自动弹浏览器。
 *
 * 背景（2026-11-20 事故）：桥每 30 分钟后台跑 `agy -p /usage` 刷额度，
 * 账号 keyring 读失败时 agy 静默回落交互式 OAuth，直接调 PATH 里的 open
 * 弹出 Chrome 的 Google 授权页。用户没做任何操作，浏览器自己跳出来。
 * 这里锁住三件事：
 *   1) shim 目录里每个浏览器入口都是可执行脚本；
 *   2) shimmedEnv 把 shim 前置进 PATH 且不改调用方 env；
 *   3) 真跑一次 shim，URL 只落日志、不启动浏览器。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { ensureBrowserShim, withBrowserShim } = await import("../lib/browser-shim.mjs");
const { shimmedEnv } = await import("../lib/quota.mjs");

test("ensureBrowserShim 写出可执行的浏览器入口", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-shim-"));
  const logFile = join(dir, "opened.log");
  ensureBrowserShim(dir, logFile);
  for (const name of ["open", "xdg-open"]) {
    const file = join(dir, name);
    assert.equal(statSync(file).mode & 0o100, 0o100, `${name} 应可执行`);
    assert.match(readFileSync(file, "utf8"), /AGY_BRIDGE_BROWSER_LOG/);
  }
});

test("withBrowserShim 前置 PATH 且不修改传入 env", () => {
  const env = { PATH: "/usr/bin:/bin" };
  const next = withBrowserShim(env, "/shim", "/tmp/opened.log");
  assert.equal(next.PATH, "/shim:/usr/bin:/bin");
  assert.equal(next.AGY_BRIDGE_BROWSER_LOG, "/tmp/opened.log");
  assert.equal(env.PATH, "/usr/bin:/bin", "原始 env 不能被改");
});

test("shimmedEnv 换 HOME 但仍前置 shim", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-shim-home-"));
  process.env.AGY_BRIDGE_HOME_DIR = dir;
  const env = shimmedEnv("/tmp/private-home");
  assert.equal(env.HOME, "/tmp/private-home");
  assert.equal(env.PATH.split(":")[0], join(dir, "no-browser"));
  delete process.env.AGY_BRIDGE_HOME_DIR;
});

test("真跑 shim：URL 只落日志，不启动浏览器", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-shim-run-"));
  const logFile = join(dir, "opened.log");
  ensureBrowserShim(dir, logFile);
  const url = "https://accounts.google.com/o/oauth2/auth?client_id=demo";
  execFileSync(join(dir, "open"), [url], { env: { ...process.env, AGY_BRIDGE_BROWSER_LOG: logFile } });
  assert.equal(readFileSync(logFile, "utf8").trim(), url);
  // 非 URL 参数不写日志
  execFileSync(join(dir, "open"), ["--version"], { env: { ...process.env, AGY_BRIDGE_BROWSER_LOG: logFile } });
  assert.equal(readFileSync(logFile, "utf8").trim(), url);
});
