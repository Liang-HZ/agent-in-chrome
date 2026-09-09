// 对外只有 winProc() / makeWinProcSource()，形状与 POSIX 版 procSource 相同：`.get(pid)`
// 回 {ppid, tty, command, name, start}。两个模块共用它——agent-identity 认「谁在开这一组」，
// session-id 认「是不是同一个客户端」；单开一个文件是因为 agent-identity 已经 import
// session-id，放进任何一边都会绕成循环依赖。取法与 POSIX 那边正好相反：一次把整条祖先链
// 取回来记住，全程只付一次 PowerShell 启动费。

import { execFileSync } from "node:child_process";

const MAX_HOPS = 12;

const TERMINALS = new Set([
  "cmd.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe", "openconsole.exe",
  "conhost.exe", "bash.exe", "sh.exe", "zsh.exe", "mintty.exe", "wsl.exe", "wslhost.exe",
  "git-bash.exe", "alacritty.exe", "wezterm-gui.exe", "hyper.exe", "cygwin.exe",
]);

const ROOTS = new Set(["explorer.exe", "services.exe", "wininit.exe", "winlogon.exe", "userinit.exe", "svchost.exe", "system", "idle"]);

export function isWinTerminal(name) {
  return !!name && TERMINALS.has(String(name).toLowerCase());
}

export function isWinRoot(name) {
  return !!name && ROOTS.has(String(name).toLowerCase());
}

function chainScript(pid, maxHops) {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "$m=@{}",
    "foreach($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine,Name){$m[[uint32]$p.ProcessId]=$p}",
    `$id=[uint32]${pid}`,
    "$o=@()",
    `for($i=0;$i -lt ${maxHops};$i++){`,
    "$p=$m[$id]; if(-not $p){break}",
    "$s=''; if($p.CreationDate){$s=[string]$p.CreationDate.ToFileTimeUtc()}",
    "$o+=[pscustomobject]@{pid=[int]$p.ProcessId;ppid=[int]$p.ParentProcessId;name=[string]$p.Name;cmd=[string]$p.CommandLine;start=$s}",
    "$id=[uint32]$p.ParentProcessId; if($id -le 0){break}}",
    "ConvertTo-Json -Compress -Depth 3 -InputObject @($o)",
  ].join(";");
}

function runChain(pid, exec, maxHops) {
  const b64 = Buffer.from(chainScript(pid, maxHops), "utf16le").toString("base64");
  const out = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64], {
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const rows = JSON.parse(String(out || "[]").trim() || "[]");
  return Array.isArray(rows) ? rows : [rows];
}

/*
 * 和 POSIX 版 procSource 同形状的快照源：只需要 `.get(pid)`。
 *
 * 记忆化的是**整条链**：第一次 get() 把从那个 pid 往上的每一跳都填进 memo，
 * 之后同一条链上的查询一次子进程都不再起。要查的 pid 不在 memo 里（链断了、
 * 或调用方从别处拿了个 pid）才会再起一次，且总次数封顶——一个 server 进程里
 * 起三次 PowerShell 已经说明链有问题，再起下去只是拖慢握手。
 */
export function makeWinProcSource(exec = execFileSync, { maxHops = MAX_HOPS, maxQueries = 3 } = {}) {
  const memo = new Map();
  let queries = 0;
  const load = (pid) => {
    if (queries >= maxQueries) return;
    queries++;
    let rows = [];
    try {
      rows = runChain(pid, exec, maxHops);
    } catch {
    }
    if (!memo.has(pid)) memo.set(pid, null);
    for (const r of rows) {
      const id = Number(r?.pid);
      if (!Number.isInteger(id) || id <= 0) continue;
      memo.set(id, {
        ppid: Number.isInteger(Number(r.ppid)) ? Number(r.ppid) : null,
        tty: null,
        command: String(r.cmd || r.name || "").trim(),
        name: String(r.name || "").trim(),
        start: String(r.start || "") || null,
      });
    }
  };
  return {
    get(pid) {
      if (!Number.isInteger(pid) || pid <= 1) return null;
      if (!memo.has(pid)) load(pid);
      return memo.get(pid) || null;
    },
  };
}

/*
 * 进程内共享的那一份：agent-identity 的 procSource 和 session-id 的
 * processInfo / parentStartToken 认的必须是**同一张快照**——不只是省下两次
 * PowerShell 启动，更是因为两边各查一次会看到两个时刻的进程表，锚点和身份指纹
 * 对不上时的排查成本远高于这点开销。
 */
let shared = null;
export function winProc(exec = execFileSync) {
  if (!shared) shared = makeWinProcSource(exec || execFileSync);
  return shared;
}

/* 只给测试用：换掉共享快照（传 null 恢复成真机的那一份） */
export function setWinProc(src) {
  shared = src;
}
