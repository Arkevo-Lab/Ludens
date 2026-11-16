/** Interpreter and source paths shared by the Ludens host and offline Dashboard readers. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The module may load from the source tree or from a copied workspace-package store. */
const repository = (() => {
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    resolve(process.cwd(), ".."),
    process.cwd(),
  ];
  return candidates.find(root => existsSync(join(root, "core", "package.json"))
    && existsSync(join(root, "protocol", "package.json"))) ?? candidates[0];
})();
const projectPython = resolve(repository, "core/python/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

export function pythonExecutable(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.LUDENS_PYTHON || (existsSync(projectPython) ? projectPython : (process.platform === "win32" ? "python" : "python3"));
}

/** Absolute taskkill path, so a PATH entry cannot shadow process-tree cleanup. */
export function taskkillExecutable(): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const candidate = join(systemRoot, "System32", "taskkill.exe");
  return existsSync(candidate) ? candidate : "taskkill.exe";
}

/** Windows has no process groups: kill a launcher or shim and its descendants by PID. */
export function killProcessTree(pid: number, done: () => void = () => {}): void {
  try { execFile(taskkillExecutable(), ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, () => done()); }
  catch { done(); }
}

export function isWindowsShim(executable: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
}

export interface PythonCommand { file: string; args: string[]; windowsVerbatimArguments: boolean }

/** Node refuses to spawn `.cmd`/`.bat` shims directly on Windows (EINVAL), so route them through cmd.exe. */
export function pythonCommand(executable: string, args: string[]): PythonCommand {
  if (!isWindowsShim(executable)) return { file: executable, args, windowsVerbatimArguments: false };
  const quote = (value: string) => /^[\w\-.:\\/=]+$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;
  const line = [`"${executable}"`, ...args.map(quote)].join(" ");
  return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

export function pythonModulePaths(): string[] {
  return [resolve(repository, "core/python"), resolve(repository, "baseware/python")];
}

export function pythonEnvironment(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...overrides };
  const executable = pythonExecutable(environment);
  const paths = [...(isAbsolute(executable) ? [dirname(executable)] : []), ...(environment.PATH?.split(delimiter) ?? [])];
  // Python's Windows defaults follow the console code page; Ludens pipes and files are UTF-8.
  return { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...environment, LUDENS_PYTHON: executable, PATH: [...new Set(paths)].join(delimiter),
    PYTHONPATH: [...new Set([...pythonModulePaths(), ...(environment.PYTHONPATH?.split(delimiter) ?? [])])].join(delimiter) };
}
