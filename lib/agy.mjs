import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** 找到官方 agy 二进制：AGY_BIN > ~/.local/bin/agy > PATH。 */
export function findAgy(env = process.env) {
  if (env.AGY_BIN) return env.AGY_BIN;
  const candidates = [join(homedir(), ".local", "bin", "agy"), ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "agy"))];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("agy not found; install the Antigravity CLI and sign in once with `agy`");
  return found;
}
