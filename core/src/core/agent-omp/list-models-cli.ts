import { listAvailableOmpModels } from "./models.ts";

interface CliModelQueryOptions {
  workspace?: string;
  home?: string;
  currentModel?: string | null;
}

async function main() {
  const idx = process.argv.indexOf("--options");
  const raw = idx >= 0 ? process.argv[idx + 1] : undefined;
  const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  const options: CliModelQueryOptions = {
    ...(typeof parsed.workspace === "string" ? { workspace: parsed.workspace } : {}),
    ...(typeof parsed.home === "string" ? { home: parsed.home } : {}),
    ...("currentModel" in parsed
      ? { currentModel: typeof parsed.currentModel === "string" ? parsed.currentModel : null }
      : {}),
  };
  const catalog = await listAvailableOmpModels(options);
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(catalog)}\n`, error => (error ? reject(error) : resolve()));
  });
}

main().then(
  () => process.exit(0),
  error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`, () => process.exit(1));
  },
);
