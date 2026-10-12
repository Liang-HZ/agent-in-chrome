import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const defaultMcpLauncher = () =>
  path.join(
    os.homedir(),
    ".agent-in-chrome",
    "agent-in-chrome",
    process.platform === "win32" ? "mcp-launcher.bat" : "mcp-launcher.sh",
  );

export const launcherNeedsShell = (file) => process.platform === "win32" && /\.(cmd|bat)$/i.test(String(file));

export const cmdq = (s) => (/[\s&|<>^"()]/.test(String(s)) ? `"${String(s).replace(/"/g, `""`)}"` : String(s));

export function spawnMcpLauncher(file, opts = {}) {
  if (launcherNeedsShell(file)) {
    return spawn(cmdq(file), { ...opts, shell: true, windowsHide: true });
  }
  return spawn(file, [], opts);
}
