import { existsSync } from "node:fs";
import { basename } from "node:path";

export interface ShellInfo {
  kind: "bash" | "powershell";
  path: string;
}

const WINDOWS_BASH = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  `${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`,
];
const WINDOWS_PWSH = ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"];

// Models write better bash, so prefer it; fall back to PowerShell on Windows.
export function detectShell(preference?: string): ShellInfo {
  if (preference) {
    const p = preference.toLowerCase();
    if (p === "bash") return { kind: "bash", path: findWindowsBash() ?? "bash" };
    if (p === "powershell" || p === "pwsh") return { kind: "powershell", path: findPwsh() };
    const name = basename(p);
    return { kind: name.includes("pwsh") || name.includes("powershell") ? "powershell" : "bash", path: preference };
  }
  if (process.platform !== "win32") return { kind: "bash", path: existsSync("/bin/bash") ? "/bin/bash" : "sh" };
  const bash = findWindowsBash();
  return bash ? { kind: "bash", path: bash } : { kind: "powershell", path: findPwsh() };
}

const findWindowsBash = () => (process.platform === "win32" ? WINDOWS_BASH.find(existsSync) : "/bin/bash");
const findPwsh = () => WINDOWS_PWSH.find(existsSync) ?? "powershell.exe";

export function shellArgs(shell: ShellInfo, command: string): string[] {
  return shell.kind === "bash" ? ["-c", command] : ["-NoProfile", "-NonInteractive", "-Command", command];
}
