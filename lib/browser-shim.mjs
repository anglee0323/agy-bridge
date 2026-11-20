/**
 * 拦住 agy 的浏览器打开动作。
 *
 * 现象（2026-11-20 复现）：账号在私有 HOME 下 keyring 读不到 token 时，
 * `agy -p /usage`（额度刷新，桥每 30 分钟后台跑一次）会静默回落到交互式 OAuth，
 * 直接调 PATH 里的 `open`/`xdg-open` 弹出 Chrome 的 Google 登录授权页。
 * 没有任何请求、也没人点按钮，浏览器自己跳出来，用户会以为被入侵。
 *
 * 做法：给 agy 单独准备一个 PATH 前缀目录，里面放 open / xdg-open 等同名脚本，
 * 只把 URL 追加到文件并 exit 0。agy 认为浏览器已打开，拿不到 code 就会超时失败，
 * 桥这边如实报 AUTH 错误——和"账号不可用"的实际情况一致，只是不再骚扰用户。
 *
 * 只在桥的子进程里生效（注入 env.PATH），不动用户全局的 PATH 和 shell 配置。
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** agy 可能调用的所有浏览器打开入口 */
const SHIM_NAMES = ["open", "xdg-open", "gnome-open", "kde-open", "www-browser", "x-www-browser"];

const SHIM_BODY = `#!/bin/sh
# 由 agy-bridge 注入：只记录 URL，不启动浏览器（见 lib/browser-shim.mjs）
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) printf '%s\\n' "$arg" >> "$AGY_BRIDGE_BROWSER_LOG" ;;
  esac
done
exit 0
`;

/**
 * 准备 shim 目录，返回需要加到 PATH 最前面的路径。
 * 目录里每个文件名都写成同一份脚本；Windows 不适用（桥只跑 macOS/Linux）。
 */
export function ensureBrowserShim(dir, logFile) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of SHIM_NAMES) {
    const file = join(dir, name);
    writeFileSync(file, SHIM_BODY);
    chmodSync(file, 0o700);
  }
  if (!existsSync(logFile)) writeFileSync(logFile, "");
  return dir;
}

/**
 * 把 shim 目录前置进 PATH，并告诉脚本往哪写日志。
 * 返回新的 env（不修改传入对象）。
 */
export function withBrowserShim(env, dir, logFile) {
  const sep = process.platform === "win32" ? ";" : ":";
  const path = env.PATH ?? env.Path ?? "";
  return {
    ...env,
    PATH: path ? `${dir}${sep}${path}` : dir,
    AGY_BRIDGE_BROWSER_LOG: logFile,
  };
}
