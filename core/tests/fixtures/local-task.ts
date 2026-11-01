import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface LocalTask {
  name: string; taskPath: string; workspace: string;
}

/** A minimal in-workspace Harbor task: deterministic program plus a verifier that grades frozen measurements. */
export async function createLocalTask(workspace: string, name = "ludens/smoke"): Promise<LocalTask> {
  const id = name.split("/").at(-1)!;
  const task = join(workspace, "benchmarks/tasks", id);
  await mkdir(join(task, "tests"), { recursive: true });
  await mkdir(join(task, "environment"), { recursive: true });
  await mkdir(join(workspace, "benchmarks/runs"), { recursive: true });
  await writeFile(join(task, "task.toml"), `schema_version = "1.4"\n\n[task]\nname = "${name}"\nversion = "1"\ndescription = "Deterministic local fixture task."\n\n[verifier]\ntimeout_sec = 60\n\n[verifier.env]\nBUN = ${JSON.stringify(process.execPath)}\n`);
  await writeFile(join(task, "instruction.md"), "Run the bound program and grade the frozen measurements.\n");
  await writeFile(join(task, "environment/README.md"), "No environment setup required.\n");
  await writeFile(join(task, "tests/test.sh"), '"$BUN" "$LUDENS_BENCH_TASK_DIR/tests/verify.ts"\n');
  await writeFile(join(task, "tests/verify.ts"), `
    import { readFile, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const measurements = JSON.parse(await readFile(join(process.env.LUDENS_BENCH_ARTIFACTS!, "measurements.json"), "utf8"));
    if (typeof measurements.value !== "number") throw new Error("Invalid measurements");
    await writeFile(join(process.env.LUDENS_BENCH_VERIFIER_DIR!, "reward.json"), JSON.stringify({ graded: measurements.value }) + "\\n");
  `);
  await writeFile(join(workspace, "benchmarks/runs", `${id}.json`), JSON.stringify({
    task: name,
    argv: ["{bun}", "-e", "await Bun.write(process.env.LUDENS_BENCH_ARTIFACTS + '/measurements.json', JSON.stringify({ value: 1 }));"],
    workspace: "isolated",
    seconds: 60,
    parameters: {},
  }, null, 2) + "\n");
  return { name, taskPath: task, workspace };
}
