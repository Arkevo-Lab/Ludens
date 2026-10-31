/** Interpreter and source paths shared by the RSA host and offline Dashboard readers. */
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
  return candidates.find(root => existsSync(join(root, "rsa", "package.json"))
    && existsSync(join(root, "protocol", "package.json"))) ?? candidates[0];
})();
const projectPython = resolve(repository, "rsa/python/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

export function pythonExecutable(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.RSA_PYTHON || (existsSync(projectPython) ? projectPython : "python3");
}

export function pythonModulePaths(): string[] {
  return [resolve(repository, "rsa/python"), resolve(repository, "baseware/python")];
}

export function pythonEnvironment(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...overrides };
  const executable = pythonExecutable(environment);
  const paths = [...(isAbsolute(executable) ? [dirname(executable)] : []), ...(environment.PATH?.split(delimiter) ?? [])];
  return { ...environment, RSA_PYTHON: executable, PATH: [...new Set(paths)].join(delimiter),
    PYTHONPATH: [...new Set([...pythonModulePaths(), ...(environment.PYTHONPATH?.split(delimiter) ?? [])])].join(delimiter) };
}
