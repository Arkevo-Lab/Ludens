import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launchPlan, parseConfig, petLaunchCommand, WorkspaceLauncher, type DriverManifest, type LaunchIO, type LaunchPlan } from "../src/daemon/launcher.ts";
import { getDriver } from "@ludens/baseware/drivers/registry.ts";
import { ensureWorkspaceIdentity, ludensHome, mergeConnectionConfig, registerWorkspace, validateConnectionConfig } from "@ludens/protocol/ludens";
import { ompSettingsOverrides } from "../src/core/agent-omp/session.ts";
import {
  updateGlobalConnection,
  updateWorkspaceConnection,
  workspaceConnection,
  upsertBasewareMachine,
  basewareOverview,
  updateWorkspaceMachines,
  removeBasewareMachine,
} from "../src/core/query/workspaces.ts";

const fixtureManifests: Record<string, DriverManifest> = {
  "bridge-fixture": { id: "bridge-fixture", transport: "bridge", defaultPort: 47991, needsGame: true,
    launchCommand: ["/fixture/Emulator.app/Contents/MacOS/emulator"], launchEnv: { FIXTURE_STACK_SIZE: "200000" } },
  "prepared-fixture": { id: "prepared-fixture", transport: "bridge", defaultPort: 47990 },
  "dual-fixture": { id: "dual-fixture", transport: "bridge", defaultPort: 47992, needsGame: true,
    launchCommand: ["/fixture/Dual.app/Contents/MacOS/dual"] },
};
const manifestFor = (id: string): DriverManifest => {
  if (fixtureManifests[id]) return fixtureManifests[id];
  const { load: _load, fallbackVersion: _fallback, ...manifest } = getDriver(id);
  return { ...manifest, version: _fallback };
};

class FakeServices implements LaunchIO {
  calls: string[][] = [];
  events: string[] = [];
  jobs = new Map<string, number>();
  starts: string[] = [];
  failStart: string | null = null;
  externalEmulator = false;
  externalBaseware = false;
  externalHost = false;
  externalPet = false;
  petReadyAfter = 0;
  basewareConnected = true;
  basewareMode = "manual";
  preparedBridgePid: number | null = null;
  bridgeClientPids: number[] = [];
  bridgePort: number | undefined;
  dashboard = false;
  occupiedDashboard = false;
  dashboardBuild = true;
  mode = "manual";
  cleanupReads = 0;
  clock = 0;

  constructor(readonly plan: LaunchPlan) { this.bridgePort = plan.config.port; }
  target(name: string) {
    const hash = createHash("sha256").update(this.plan.workspace).digest("hex").slice(0, 16);
    return name === "pet" ? "dev.ludens.pet" : `dev.ludens.core.${hash}.${name}`;
  }
  stateFile(name: string) {
    return join(name === "pet" ? this.plan.sharedPet.background : this.plan.background, `${name}.job.json`);
  }
  targetForStateFile(path: string) {
    for (const name of ["emulator", "baseware", "host", "dashboard", "pet"] as const) {
      if (this.stateFile(name) === path) return this.target(name);
    }
    return path;
  }
  seed(name: string) { this.jobs.set(this.target(name), 100 + this.jobs.size); }
  dashboardReady = async () => this.dashboard;
  petReady = async () => this.externalPet || (this.jobs.has(this.target("pet")) && this.clock >= this.petReadyAfter);
  sleep = async () => { this.clock += 500; };
  now = () => this.clock;
  note = () => {};
  async run(argv: string[], cwd: string) {
    const sharedPetLaunch = argv[0] === "python3" && argv[2] === "--label";
    expect(cwd).toBe(sharedPetLaunch ? this.plan.sharedPet.cwd : this.plan.workspace);
    this.calls.push([...argv]);
    const result = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });
    if (argv.join("\0") === this.plan.dashboardCheck.join("\0")) return this.dashboardBuild ? result() : result("", 1, "Dashboard production build is stale; run build");
    if (argv[0] === "env" && argv[2] === this.plan.baseware && argv[3] === "status") {
      expect(argv[1]).toBe(`BASEWARE_SOCKET=${this.plan.basewareSocket}`);
      if (!this.jobs.has(this.target("baseware")) && !this.externalBaseware) return result("", 1);
      this.events.push(`baseware:${this.basewareMode}:${this.basewareConnected}`);
      return result(JSON.stringify({ serviceId: "device-session", mode: this.basewareMode,
        connected: this.basewareConnected, epoch: this.basewareMode === "auto" ? "another-owner" : null }));
    }
    if (argv[0] === this.plan.ludens && argv[1] === "status") {
      if (!this.jobs.has(this.target("host")) && !this.externalHost) return result("", 1);
      const thinking = this.cleanupReads-- > 0;
      this.events.push(`host:${this.mode}:${thinking}`);
      return result(JSON.stringify({ runId: "original-session", mode: this.mode, connected: true,
        thinking, consolidating: false, maxSeconds: this.plan.config.seconds }));
    }
    if (argv[0] === this.plan.ludens && argv.slice(1).join(" ") === "auto off") {
      this.events.push("auto off");
      this.mode = "manual";
      this.basewareMode = "manual";
      this.cleanupReads = 2;
      return result();
    }
    if (argv[0] === "python3" && argv[1] === this.plan.launcher && argv[2] === "--status") {
      const pid = this.jobs.get(this.targetForStateFile(argv[3]!));
      return result(JSON.stringify(pid
        ? { registered: true, pid, state: "running", lastExitCode: null }
        : { registered: false, pid: null, state: null, lastExitCode: null }));
    }
    if (argv[0] === "python3" && argv[1] === this.plan.launcher && argv[2] === "--stop") {
      const target = this.targetForStateFile(argv[3]!);
      this.events.push(`stop:${target}`);
      this.jobs.delete(target);
      return result();
    }
    if (argv[0] === "python3" && argv[1] === this.plan.launcher) {
      const nameIndex = sharedPetLaunch ? 6 : 2;
      const name = argv[nameIndex]!;
      this.starts.push(name);
      if (sharedPetLaunch) expect(argv.slice(2, 6)).toEqual(["--label", "dev.ludens.pet", "--log-dir", this.plan.sharedPet.background]);
      expect(argv.slice(nameIndex + 1)).toEqual(this.plan.commands[name as keyof typeof this.plan.commands]!);
      if (name === this.failStart) return result("", 1, `${name} unavailable`);
      if (name === "host") expect(this.events).toContain("baseware:manual:true");
      this.seed(name);
      if (name === "dashboard") this.dashboard = true;
      return result();
    }
    if (argv[0] === "pgrep") return result(this.externalEmulator ? "999\n" : "", this.externalEmulator ? 0 : 1);
    if (argv[0] === "lsof") {
      if (argv.includes("-iTCP:3015")) return this.occupiedDashboard ? result("3015\n") : result("", 1);
      const pid = this.jobs.get(this.target("emulator")) ?? this.preparedBridgePid;
      if (argv.includes("-p")) return pid ? result(`p${pid}\nn127.0.0.1:${this.bridgePort}\n`) : result("", 1);
      if (!argv.includes(`-iTCP:${this.bridgePort}`) || !pid) return result("", 1);
      // lsof ESTABLISHED also reports the server PID; it is not a competing host.
      const baseware = this.jobs.get(this.target("baseware"));
      return result(argv.includes("-sTCP:ESTABLISHED") ? [pid, ...(baseware ? [baseware] : []), ...this.bridgeClientPids].join("\n") : String(pid));
    }
    throw new Error(`Unexpected command: ${JSON.stringify(argv)}`);
  }
}

const plan = () => launchPlan(parseConfig({ driver: "bridge-fixture", game: "games/A game; $(touch BAD).rom", pet: true }, manifestFor("bridge-fixture")),
  "/tmp/Workspace with spaces", "/tmp/Source with spaces", "/tmp/baseware-test.sock", manifestFor("bridge-fixture"));

test("up rejects unidentified and conflicting workspaces before loading drivers, including dry runs", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "ludens-up-identity-")));
  try {
    const home = join(directory, "global"), original = join(directory, "original"), copy = join(directory, "copy"), legacy = join(directory, "legacy");
    await mkdir(original);
    await mkdir(legacy);
    const marker = join(directory, "driver-loaded");
    const driver = join(directory, "driver.ts");
    await writeFile(driver, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); throw new Error("driver must not load");`);
    const config = JSON.stringify({ driver: "fixture", driverPackage: `file:${driver}` });
    await writeFile(join(original, "ludens.json"), config);
    await writeFile(join(legacy, "ludens.json"), config);
    const identity = await ensureWorkspaceIdentity(original);
    await registerWorkspace(original, home);
    const registration = await readFile(join(home, "registry", `${identity.id}.json`), "utf8");
    await cp(original, copy, { recursive: true });
    for (const workspace of [copy, legacy]) {
      for (const extra of [[], ["--dry-run"]]) {
        const env: NodeJS.ProcessEnv = { ...process.env, LUDENS_HOME: home };
        delete env.LUDENS_WORKSPACE; delete env.LUDENS_SOCKET; delete env.BASEWARE_SOCKET;
        const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli/main.ts"), "--workspace", workspace, "up", ...extra], {
          env, stdout: "pipe", stderr: "pipe",
        });
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(code).not.toBe(0);
        expect(stderr).toContain(workspace === copy ? "--new-id" : "workspace import");
      }
    }
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await readdir(legacy)).toEqual(["ludens.json"]);
    expect(await readFile(join(home, "registry", `${identity.id}.json`), "utf8")).toBe(registration);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("default web startup starts the Dashboard without launching or waiting for Electron", async () => {
  const config = parseConfig({ driver: "cua" }, manifestFor("cua"));
  expect(config).toMatchObject({ dashboard: true, pet: false });
  const value = await launchPlan(config, "/tmp/Web workspace", "/tmp/Source", "/tmp/web-baseware.sock", manifestFor("cua"));
  expect(value.commands.pet).toBeUndefined();
  const io = new FakeServices(value);
  io.petReadyAfter = Infinity;
  const launcher = new WorkspaceLauncher(value, io);
  await launcher.up();
  expect(io.starts).toEqual(["baseware", "host", "dashboard"]);
  expect(io.clock).toBe(0);
  // Disabling startup must also leave a Pet opened by another workspace alone.
  io.seed("pet");
  await launcher.up();
  expect(io.jobs.has(io.target("pet"))).toBe(true);
  expect(io.calls.some(argv => argv[2] === "--stop")).toBe(false);
});

test("system Pet readiness uses the Dashboard pet endpoint", async () => {
  const paths: string[] = [];
  let connected = true, status = 200;
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    return path === "/api/pet" ? Response.json({ connected }, { status }) : new Response("missing", { status: 404 });
  } });
  // Exercise the real HTTP probe without running any service or device command.
  const io = new WorkspaceLauncher(await plan())["io"];
  try {
    expect(await io.petReady(server.url.origin)).toBe(true);
    connected = false;
    expect(await io.petReady(server.url.origin)).toBe(false);
    connected = true; status = 503;
    expect(await io.petReady(server.url.origin)).toBe(false);
    expect(paths).toEqual(["/api/pet", "/api/pet", "/api/pet"]);
  } finally { server.stop(true); }
});

test("Dashboard reuse requires the same global home and rejects occupied mismatched services before startup", async () => {
  let home = ludensHome();
  const server = Bun.serve({ port: 0, fetch(request) {
    return new URL(request.url).pathname === "/api/catalog" ? Response.json([]) : Response.json({ home });
  } });
  try {
    const value = await plan();
    const io = new WorkspaceLauncher(value)["io"];
    expect(await io.dashboardReady(server.url.origin)).toBe(true);
    home = "/tmp/different-ludens-home";
    expect(await io.dashboardReady(server.url.origin)).toBe(false);
    const occupied = new FakeServices(value);
    occupied.occupiedDashboard = true;
    await expect(new WorkspaceLauncher(value, occupied).up()).rejects.toThrow("different Ludens home");
    expect(occupied.starts).toEqual([]);
    expect(occupied.calls.some(argv => argv[2] === "--stop")).toBe(false);
  } finally { server.stop(true); }
});

test("managed Dashboard uses a current production build and fails before starting devices when stale", async () => {
  const value = await plan();
  expect(value.commands.dashboard).toEqual(["npm", "--prefix", "/tmp/Source with spaces/app", "run", "start"]);
  const io = new FakeServices(value);
  io.dashboardBuild = false;
  await expect(new WorkspaceLauncher(value, io).up()).rejects.toThrow("production build is stale");
  expect(io.starts).toEqual([]);
  expect(io.calls).toEqual([value.dashboardCheck]);
});

test("launch config keeps limits explicit and paths as literal argv entries", async () => {
  const value = await plan();
  expect(value.config).toMatchObject({ port: 47991, seconds: 1800, requests: 1000 });
  // Default follows the selected model's native OMP compaction trigger; no flag is passed.
  expect(parseConfig({ driver: "prepared-fixture" }, manifestFor("prepared-fixture")).compactionThreshold).toBeUndefined();
  expect(value.commands.host).not.toContain("--compaction-threshold");
  const explicit = await launchPlan(parseConfig({ driver: "bridge-fixture", game: "games/x.rom", compactionThreshold: 200000 }, manifestFor("bridge-fixture")),
    "/tmp/Workspace with spaces", "/tmp/Source with spaces", "/tmp/baseware-test.sock", manifestFor("bridge-fixture"));
  expect(explicit.commands.host).toEqual(expect.arrayContaining(["--compaction-threshold", "200000"]));
  expect(parseConfig({ driver: "prepared-fixture" }, manifestFor("prepared-fixture")).port).toBe(47990);
  expect(() => parseConfig({ driver: "bridge-fixture", second: 10 }, manifestFor("bridge-fixture"))).toThrow("Unknown");
  expect(() => parseConfig({ driver: "prepared-fixture", game: "game.rom" }, manifestFor("prepared-fixture"))).toThrow("does not support launching a game");
  expect(value.commands.emulator).toEqual(["env", "FIXTURE_STACK_SIZE=200000", "LUDENS_BRIDGE_PORT=47991",
    ...manifestFor("bridge-fixture").launchCommand!,
    "/tmp/Workspace with spaces/games/A game; $(touch BAD).rom"]);
  expect(value.commands.baseware).toEqual(["/tmp/Source with spaces/baseware/bin/baseware", "serve",
    "--driver", "bridge-fixture", "--port", "47991", "--socket", "/tmp/baseware-test.sock",
    "--data-dir", "/tmp/Workspace with spaces/logs/baseware", "--diagnostics", "normal"]);
  expect(value.commands.host).toContain("/tmp/Source with spaces/core/bin/ludens");
  expect(value.commands.host).toContain("--baseware-socket");
  expect(value.commands.host).not.toContain("--driver");
  expect(value.commands.host).not.toContain("--port");
  expect(value.commands.pet).toContain("/tmp/Workspace with spaces");
  expect(value.commands.pet).not.toContain("--profile");
  expect(value.sharedPet).toEqual({ cwd: "/tmp/Source with spaces", background: join(ludensHome(), "pet/background") });
});

test("bridge plugins require a resolved port before any services start", () => {
  const manifest: DriverManifest = { id: "fixture", transport: "bridge" };
  expect(() => parseConfig({ driver: "fixture" }, manifest)).toThrow("requires a bridge port");
  expect(parseConfig({ driver: "fixture", port: 47991 }, manifest).port).toBe(47991);
  expect(parseConfig({ driver: "fixture" }, { ...manifest, defaultPort: 47992 }).port).toBe(47992);
  expect(() => parseConfig({ driver: "fixture" }, { ...manifest, defaultPort: 65536 })).toThrow("1 to 65535");
});

test("an explicit bridge port overrides plugin launch environment for both backend and Baseware", async () => {
  const manifest: DriverManifest = { id: "fixture", transport: "bridge", defaultPort: 47991,
    launchCommand: ["fixture-emulator"], launchEnv: { LUDENS_BRIDGE_PORT: "47992", FIXTURE_OPTION: "kept" } };
  const config = parseConfig({ driver: "fixture", port: 47993, game: "game.rom" }, manifest);
  const value = await launchPlan(config, "/tmp/fixture", "/tmp/Source", "/tmp/fixture.sock", manifest);
  const command = value.commands.emulator!;
  // Exercise env's effective value, rather than relying on an argv order assertion.
  const child = Bun.spawn([...command.slice(0, -2), process.execPath, "-e",
    "process.stdout.write(JSON.stringify([process.env.LUDENS_BRIDGE_PORT, process.env.FIXTURE_OPTION]))"],
    { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  const [backendPort, option] = JSON.parse(await new Response(child.stdout).text());
  expect(backendPort).toBe("47993");
  expect(option).toBe("kept");
  expect(value.commands.baseware![value.commands.baseware!.indexOf("--port") + 1]).toBe(backendPort);
});

test("Cua launch config uses its native service without choosing a workspace observation", async () => {
  const config = parseConfig({ driver: "cua", cuaCommand: "/Applications/Cua Driver/cua-driver", dashboard: false, pet: false }, manifestFor("cua"));
  const value = await launchPlan(config, "/tmp/Desktop workspace", "/tmp/Source", "/tmp/cua-baseware.sock", manifestFor("cua"));
  expect(config.port).toBeUndefined();
  expect(value.commands.emulator).toBeUndefined();
  expect(value.commands.baseware).toEqual(["/tmp/Source/baseware/bin/baseware", "serve", "--driver", "cua",
    "--cua-command", "/Applications/Cua Driver/cua-driver", "--socket", "/tmp/cua-baseware.sock",
    "--data-dir", "/tmp/Desktop workspace/logs/baseware", "--diagnostics", "normal"]);
  expect(value.commands.host).not.toContain("--auto-observe");
  const defaults = await launchPlan(parseConfig({ driver: "cua" }, manifestFor("cua")), "/tmp/Desktop workspace", "/tmp/Source", "/tmp/cua-baseware.sock", manifestFor("cua"));
  expect(defaults.commands.baseware).not.toContain("--cua-command");
  expect(defaults.commands.baseware).not.toContain("--port");
  expect(() => parseConfig({ driver: "cua", port: 47991 }, manifestFor("cua"))).toThrow("bridge port");
  expect(() => parseConfig({ driver: "cua", game: "game.rom" }, manifestFor("cua"))).toThrow("game");
  expect(() => parseConfig({ driver: "prepared-fixture", cuaCommand: "cua-driver" }, manifestFor("prepared-fixture"))).toThrow("cuaCommand");
});

test("Cua startup and shutdown only manage its services, without emulator bridge probes", async () => {
  const value = await launchPlan(parseConfig({ driver: "cua", dashboard: false, pet: false }, manifestFor("cua")), "/tmp/Desktop workspace", "/tmp/Source", "/tmp/cua-baseware.sock", manifestFor("cua"));
  const io = new FakeServices(value);
  const launcher = new WorkspaceLauncher(value, io);
  const status = await launcher.up();
  expect(status.host?.mode).toBe("manual");
  expect(io.starts).toEqual(["baseware", "host"]);
  await launcher.up();
  expect(io.starts).toEqual(["baseware", "host"]);
  await launcher.down(false);
  expect(io.calls.filter(argv => argv[2] === "--stop").map(argv => io.targetForStateFile(argv[3]!))).toEqual(
    ["host", "baseware"].map(name => io.target(name)));
  expect(io.calls.some(argv => ["pgrep", "lsof"].includes(argv[0]!))).toBe(false);
});

test("an external bridge manifest launches its device without desktop dependencies", async () => {
  const config = parseConfig({ driver: "dual-fixture", game: "games/Dual game.rom" }, manifestFor("dual-fixture"));
  const value = await launchPlan(config, "/tmp/Dual workspace", "/tmp/Source", "/tmp/dual-baseware.sock", manifestFor("dual-fixture"));
  expect(config.port).toBe(47992);
  expect(value.commands.emulator).toEqual(["env", "LUDENS_BRIDGE_PORT=47992",
    "/fixture/Dual.app/Contents/MacOS/dual", "/tmp/Dual workspace/games/Dual game.rom"]);
  expect(value.commands.baseware).toContain("dual-fixture");
  expect(value.commands.baseware).toContain("47992");
  expect(value.commands.baseware).not.toContain("--cua-command");
  expect(value.commands.host).not.toContain("--auto-observe");
  expect(() => parseConfig({ driver: "dual-fixture", game: "games/Dual game.rom", cuaCommand: "/tools/cua-driver" }, manifestFor("dual-fixture"))).toThrow("stdio driver");
  const io = new FakeServices(value);
  io.bridgePort = 47992;
  expect((await new WorkspaceLauncher(value, io).up()).host?.mode).toBe("manual");
  expect(io.starts).toContain("emulator");
});

test("init and dry-run preserve existing workspace files and never invoke service commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-launch-"));
  try {
    const workspace = join(directory, "Workspace ; $ literal");
    const bin = join(directory, "bin");
    const marker = join(directory, "service-started");
    await mkdir(workspace);
    await mkdir(bin);
    // Trap any attempt to execute service commands; the CLI itself uses an absolute Bun path.
    for (const name of ["python3", "pgrep", "lsof", "npm", "env"]) {
      const file = join(bin, name);
      await writeFile(file, '#!/bin/sh\nprintf called > "$SERVICE_MARKER"\nexit 97\n');
      await chmod(file, 0o755);
    }
    await writeFile(join(workspace, "AGENTS.md"), "My existing workspace instructions\n");
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli/main.ts"), ...args], {
        cwd: workspace, env: { ...process.env, LUDENS_HOME: join(directory, "global"), PATH: bin, SERVICE_MARKER: marker, LUDENS_WORKSPACE: workspace }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    const packagePath = join(directory, "external-driver.ts");
    await writeFile(packagePath, `export default { ...${JSON.stringify(fixtureManifests["bridge-fixture"])}, load() { throw new Error("init must not load the provider"); } };`);
    expect((await run("init", "--driver", "bridge-fixture", "--driver-package", `file:${packagePath}`, "--game", "games/Uninstalled ; $ game.rom", "--seconds", "600")).code).toBe(0);
    const configBefore = await readFile(join(workspace, "ludens.json"), "utf8");
    const preview = await run("up", "--dry-run");
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({ workspace: await realpath(workspace), config: { seconds: 600, pet: false } });
    expect(JSON.parse(preview.stdout).commands.pet).toBeUndefined();
    const withPet = await run("up", "--pet", "--dry-run");
    expect(withPet.code).toBe(0);
    expect(JSON.parse(withPet.stdout).commands.pet).toBeDefined();
    expect((await run("up", "--pet", "--no-pet", "--dry-run")).stderr).toContain("Choose either --pet or --no-pet");
    const repeated = await run("init", "--driver", "cua");
    expect(repeated.code).not.toBe(0);
    expect(repeated.stderr).toContain("EEXIST");
    expect(await readFile(join(workspace, "ludens.json"), "utf8")).toBe(configBefore);
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe("My existing workspace instructions\n");
    expect((await readdir(workspace)).sort()).toEqual([".ludens", "AGENTS.md", "ludens.json", "perception.py"]);
    expect(await readFile(join(workspace, "perception.py"), "utf8")).toContain("NotImplementedError");
    const desktop = join(directory, "Desktop workspace");
    expect((await run("--workspace", desktop, "init", "--driver", "cua", "--cua-command", "./tools/cua-driver", "--pet")).code).toBe(0);
    const desktopPreview = await run("--workspace", desktop, "up", "--dry-run");
    expect(desktopPreview.code).toBe(0);
    expect(JSON.parse(desktopPreview.stdout)).toMatchObject({ config: { driver: "cua", cuaCommand: "./tools/cua-driver", pet: true } });
    expect(JSON.parse(desktopPreview.stdout).commands.emulator).toBeUndefined();
    expect(JSON.parse(desktopPreview.stdout).commands.pet).toBeDefined();
    const webOnly = await run("--workspace", desktop, "up", "--no-pet", "--dry-run");
    expect(webOnly.code).toBe(0);
    expect(JSON.parse(webOnly.stdout).commands.pet).toBeUndefined();
    expect(JSON.parse(await readFile(join(desktop, "ludens.json"), "utf8")).pet).toBe(true);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("external packages resolve workspace-relative file specs and check only executable argv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-package-launch-"));
  try {
    const workspace = join(directory, "workspace");
    const driver = join(workspace, "driver");
    const bin = join(directory, "bin");
    await mkdir(driver, { recursive: true });
    await mkdir(bin);
    await writeFile(join(driver, "package.json"), JSON.stringify({
      name: "workspace-launch-fixture", version: "1.0.0", type: "module", exports: "./index.ts",
    }));
    await writeFile(join(driver, "index.ts"), 'export default { id: "fixture", transport: "bridge", defaultPort: 47991, launchCommand: ["fixture-emulator", "--headless", "literal argument"], load: async () => { throw new Error("Provider must not load during discovery"); } };');
    await writeFile(join(workspace, "game.rom"), "");
    for (const name of ["fixture-emulator", "python3", "lsof", "env", "pgrep"]) {
      const path = join(bin, name);
      await writeFile(path, '#!/bin/sh\necho launch-stopped >&2\nexit 97\n');
      await chmod(path, 0o755);
    }
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli/main.ts"), "--workspace", workspace, ...args], {
        cwd: directory, env: { ...process.env, LUDENS_HOME: join(directory, "global"), PATH: bin }, stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, stdout, stderr };
    };
    const initialized = await run("init", "--driver", "fixture", "--driver-package", "file:./driver", "--game", "game.rom");
    expect(initialized.code).toBe(0);
    const config = JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8"));
    expect(config.driverPackage).toBe("file:./driver");
    // Hand-edited relative specs must receive the same workspace interpretation on up.
    await writeFile(join(workspace, "ludens.json"), JSON.stringify({ ...config, driverPackage: "file:./driver", dashboard: false, pet: false }));
    const preview = await run("up", "--dry-run");
    expect(preview.code).toBe(0);
    const plan = JSON.parse(preview.stdout);
    expect(plan.commands.baseware).toContain(`file:${await realpath(driver)}`);
    expect(plan.commands.emulator).toEqual(["env", "LUDENS_BRIDGE_PORT=47991", "fixture-emulator", "--headless", "literal argument", join(await realpath(workspace), "game.rom")]);
    if (process.platform !== "win32") {
      const startup = await run("up");
      expect(startup.code).not.toBe(0);
      expect(startup.stderr).toContain("launch-stopped");
      expect(startup.stderr).not.toContain("Missing");
      await chmod(join(bin, "fixture-emulator"), 0o644);
      const unavailable = await run("up");
      expect(unavailable.stderr).toContain("Missing executable fixture-emulator");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000); // Real CLI startup includes two independently bounded Dashboard probes.

test("failed startup preserves ready services and repeated up resumes without duplicate hosts or takeover", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  const launcher = new WorkspaceLauncher(value, io);
  io.failStart = "dashboard";
  await expect(launcher.up()).rejects.toThrow("dashboard unavailable");
  expect(io.jobs.has(io.target("host"))).toBe(true);
  expect(io.jobs.has(io.target("emulator"))).toBe(true);
  io.failStart = null;
  const recovered = await launcher.up();
  expect(recovered.host?.mode).toBe("manual");
  await launcher.up();
  expect(io.starts).toEqual(["emulator", "baseware", "host", "dashboard", "dashboard", "pet"]);
  expect(recovered.baseware).toMatchObject({ connected: true, serviceId: "device-session" });
  expect(io.calls.some(argv => argv[1] === "auto")).toBe(false);
  expect(io.calls.some(argv => argv[2] === "--stop")).toBe(false);
});

test("down waits for takeover cleanup, stops only owned jobs, and keeps the shared Dashboard and Pet", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  for (const name of ["host", "baseware", "emulator", "pet", "dashboard"]) io.seed(name);
  const foreign = "dev.ludens.core.another-workspace.host";
  io.jobs.set(foreign, 999);
  io.dashboard = true;
  io.mode = "auto";
  io.basewareMode = "auto";
  await new WorkspaceLauncher(value, io).down(false);
  const stopHost = io.events.indexOf(`stop:${io.target("host")}`);
  expect(io.events.indexOf("auto off")).toBeLessThan(stopHost);
  expect(io.events.indexOf("host:manual:false")).toBeGreaterThan(io.events.indexOf("auto off"));
  expect(io.events.indexOf("host:manual:false")).toBeLessThan(stopHost);
  expect(io.calls.filter(argv => argv[2] === "--stop").map(argv => io.targetForStateFile(argv[3]!))).toEqual(
    ["host", "baseware", "emulator"].map(name => io.target(name)));
  expect([...io.jobs.keys()]).toEqual([io.target("pet"), io.target("dashboard"), foreign]);

  const keep = new FakeServices(value);
  for (const name of ["host", "baseware", "emulator", "pet", "dashboard"]) keep.seed(name);
  keep.dashboard = true;
  await new WorkspaceLauncher(value, keep).down(false, true);
  expect(keep.calls.filter(argv => argv[2] === "--stop").map(argv => keep.targetForStateFile(argv[3]!))).toEqual(
    ["host", "baseware"].map(name => keep.target(name)));
  expect([...keep.jobs.keys()]).toEqual([keep.target("emulator"), keep.target("pet"), keep.target("dashboard")]);
});

test("two workspaces reuse one Ludens Pet process and either workspace can explicitly stop it", async () => {
  const first = await launchPlan(parseConfig({ driver: "cua", pet: true }, manifestFor("cua")), "/tmp/First workspace", "/tmp/Source", "/tmp/first-baseware.sock", manifestFor("cua"));
  const second = await launchPlan(parseConfig({ driver: "cua", pet: true }, manifestFor("cua")), "/tmp/Second workspace", "/tmp/Source", "/tmp/second-baseware.sock", manifestFor("cua"));
  const firstIO = new FakeServices(first);
  const firstStatus = await new WorkspaceLauncher(first, firstIO).up();
  const firstPet = firstStatus.jobs.find(job => job.name === "pet")!;
  expect(firstPet).toMatchObject({ scope: "shared", log: join(ludensHome(), "pet/background/pet.log") });

  const secondIO = new FakeServices(second);
  secondIO.jobs = firstIO.jobs;
  secondIO.dashboard = true;
  const secondLauncher = new WorkspaceLauncher(second, secondIO);
  const secondStatus = await secondLauncher.up();
  expect(secondIO.starts).toEqual(["baseware", "host"]);
  expect(secondStatus.jobs.find(job => job.name === "pet")).toEqual(firstPet);
  expect(secondIO.calls.some(argv => argv.includes("--workspace"))).toBe(false);

  await secondLauncher.down(false);
  expect(secondIO.jobs.get(secondIO.target("pet"))).toBe(firstPet.pid!);
  await secondLauncher.down(false, true, true);
  expect(secondIO.jobs.has(secondIO.target("pet"))).toBe(false);
  expect(secondIO.jobs.has(firstIO.target("host"))).toBe(true);
});

test("up reuses an independently opened Ludens Pet and down never closes that app", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  io.externalPet = true;
  const launcher = new WorkspaceLauncher(value, io);
  const status = await launcher.up();
  expect(status.pet.connected).toBe(true);
  expect(status.jobs.find(job => job.name === "pet")).toMatchObject({ registered: false, pid: null });
  expect(io.starts).not.toContain("pet");
  await launcher.down(false, true, true);
  expect(io.calls.some(argv => argv[2] === "--stop" && io.targetForStateFile(argv[3]!) === io.target("pet"))).toBe(false);
  expect((await launcher.status()).pet.connected).toBe(true);
});

test("managed Ludens Pet startup waits for its activity connection after the process appears", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  io.petReadyAfter = 1500;
  const status = await new WorkspaceLauncher(value, io).up();
  expect(io.clock).toBe(1500);
  expect(status.pet.connected).toBe(true);
  expect(io.starts.filter(name => name === "pet")).toEqual(["pet"]);
});

test("detached background launcher preserves environment, records exit codes, and stops process trees", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-shared-launch-"));
  try {
    const stableCwd = join(directory, "source");
    const logs = join(directory, "shared", "alice", "background");
    const driverState = join(directory, "isolated driver state");
    const pythonOverride = join(directory, "custom Python", "bin", "python3");
    await mkdir(stableCwd);
    const pyBin = Bun.which("python3") ?? Bun.which("python") ?? "python3";
    const script = resolve(import.meta.dir, "../scripts/launch-background.py");

    const child = Bun.spawn([
      pyBin, script, "--label", "dev.ludens.pet", "--log-dir", logs, "pet",
      "env", "EXTRA_FLAG=active", process.execPath, "-e",
      "console.log(JSON.stringify({ cwd: process.cwd(), extra: process.env.EXTRA_FLAG })); process.exit(7);",
    ], {
      cwd: stableCwd,
      env: {
        ...process.env,
        LUDENS_WORKSPACE: "/tmp/stale",
        BASEWARE_EPOCH: "stale-epoch",
        XDG_STATE_HOME: driverState,
        LUDENS_PYTHON: pythonOverride,
        LUDENS_HOME: join(directory, "global"),
        SSH_AUTH_SOCK: join(directory, "agent.sock"),
        LUDENS_PERCEPTION_PERSIST: "0",
        LUDENS_PERCEPTION_HOT_SECONDS: "600",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const canonicalCwd = await realpath(stableCwd);
    const canonicalLogs = await realpath(logs);
    const stateFile = join(canonicalLogs, "pet.job.json");
    expect(JSON.parse(stdout)).toMatchObject({
      target: "dev.ludens.pet",
      workspace: canonicalCwd,
      log: join(canonicalLogs, "pet.log"),
      stateFile,
    });

    // Wait briefly for the short-lived child to exit and record exit code 7.
    let finalStatus: { registered: boolean; pid: number | null; state: string | null; lastExitCode: number | null } | null = null;
    for (let i = 0; i < 40; i++) {
      const check = Bun.spawn([pyBin, script, "--status", stateFile], { stdout: "pipe", stderr: "pipe" });
      const [statusCode, statusOut] = await Promise.all([check.exited, new Response(check.stdout).text()]);
      expect(statusCode).toBe(0);
      const parsed = JSON.parse(statusOut);
      if (parsed.state === "exited") {
        finalStatus = parsed;
        break;
      }
      await Bun.sleep(50);
    }
    expect(finalStatus).toEqual({ registered: true, pid: null, state: "exited", lastExitCode: 7 });

    const saved = JSON.parse(await readFile(stateFile, "utf8"));
    expect(saved.label).toBe("dev.ludens.pet");
    expect(saved.workspace).toBe(canonicalCwd);
    expect(saved.env.LUDENS_WORKSPACE).toBeUndefined();
    expect(saved.env.BASEWARE_EPOCH).toBeUndefined();
    expect(saved.env.XDG_STATE_HOME).toBe(driverState);
    expect(saved.env.LUDENS_PYTHON).toBe(pythonOverride);
    expect(saved.env.LUDENS_HOME).toBe(join(directory, "global"));
    expect(saved.env.SSH_AUTH_SOCK).toBe(join(directory, "agent.sock"));
    expect(saved.env.LUDENS_PERCEPTION_PERSIST).toBe("0");
    expect(saved.env.LUDENS_PERCEPTION_HOT_SECONDS).toBe("600");
    expect(saved.env.EXTRA_FLAG).toBe("active");
    expect(await readFile(join(canonicalLogs, "pet.log"), "utf8")).toContain('"extra":"active"');

    // Stopping unregisters the state file, allowing a fresh job to start and be stopped while running.
    const cleanup = Bun.spawn([pyBin, script, "--stop", stateFile], { stdout: "pipe", stderr: "pipe" });
    expect(await cleanup.exited).toBe(0);
    expect(await Bun.file(stateFile).exists()).toBe(false);

    const sleeper = Bun.spawn([
      pyBin, script, "--label", "dev.ludens.pet", "--log-dir", logs, "pet",
      process.execPath, "-e", "setInterval(() => {}, 1000);",
    ], { cwd: stableCwd, stdout: "pipe", stderr: "pipe" });
    expect(await sleeper.exited).toBe(0);
    const sleeperInfo = JSON.parse(await new Response(sleeper.stdout).text()) as { pid: number };
    expect(sleeperInfo.pid).toBeGreaterThan(0);

    const stopLive = Bun.spawn([pyBin, script, "--stop", stateFile], { stdout: "pipe", stderr: "pipe" });
    expect(await stopLive.exited).toBe(0);
    expect(await Bun.file(stateFile).exists()).toBe(false);
    expect(await readdir(stableCwd)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an externally started emulator process blocks startup before spawning or stopping anything", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  io.externalEmulator = true;
  await expect(new WorkspaceLauncher(value, io).up()).rejects.toThrow("already running outside this workspace");
  expect(io.starts).toEqual([]);
  expect(io.calls.some(argv => argv[2] === "--stop" || argv[1] === "auto")).toBe(false);
});

test("emulator process matching treats custom executable paths as POSIX regex literals", async () => {
  const executable = "/tmp/Emulator (native)[1]+.app/Contents/MacOS/emulator";
  const manifest = { ...manifestFor("bridge-fixture"), launchCommand: [executable] };
  const value = await launchPlan(parseConfig({ driver: manifest.id, game: "game.rom" }, manifest),
    "/tmp/Literal path workspace", "/tmp/Source", "/tmp/literal-path.sock", manifest);
  for (const [existingCommand, matches] of [
    [executable, true],
    [`${executable} game.rom`, true],
    [`${executable}-helper game.rom`, false],
    ["/tmp/Emulator native11Xapp/Contents/MacOS/emulator game.rom", false],
  ] as const) {
    const io = new FakeServices(value);
    const run = io.run.bind(io);
    io.run = async (argv, cwd) => {
      if (argv[0] !== "pgrep") return run(argv, cwd);
      io.calls.push([...argv]);
      // Exercise the same POSIX ERE syntax as pgrep without inspecting or
      // starting any real emulator process, including lookalikes and prefixes.
      const matcher = Bun.spawn(["grep", "-E", argv[2]!], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      matcher.stdin.write(`${existingCommand}\n`);
      matcher.stdin.end();
      const [code, stdout, stderr] = await Promise.all([
        matcher.exited, new Response(matcher.stdout).text(), new Response(matcher.stderr).text(),
      ]);
      expect(stderr).toBe("");
      return { code, stdout, stderr };
    };
    if (matches) {
      await expect(new WorkspaceLauncher(value, io).up()).rejects.toThrow("already running outside this workspace");
      expect(io.starts).toEqual([]);
    } else {
      expect((await new WorkspaceLauncher(value, io).up()).host?.mode).toBe("manual");
      expect(io.starts).toContain("emulator");
    }
  }
});

test("package launch wrappers cannot start another emulator on an externally occupied bridge", async () => {
  const value = await plan();
  value.commands.emulator = ["env", `LUDENS_BRIDGE_PORT=${value.config.port}`, "/external/package/launch.sh", "game.rom"];
  const io = new FakeServices(value);
  io.preparedBridgePid = 700;
  await expect(new WorkspaceLauncher(value, io).up()).rejects.toThrow("already listening outside this workspace");
  expect(io.starts).toEqual([]);
  expect(io.calls.some(argv => argv[2] === "--stop" || argv[1] === "auto")).toBe(false);
});

test("a bridge used by another workspace neither receives a second host nor gets stopped", async () => {
  const prepared = await launchPlan(parseConfig({ driver: "bridge-fixture" }, manifestFor("bridge-fixture")), "/tmp/Second workspace", undefined, "/tmp/second-baseware.sock", manifestFor("bridge-fixture"));
  const attach = new FakeServices(prepared);
  attach.preparedBridgePid = 700;
  attach.bridgeClientPids = [701];
  await expect(new WorkspaceLauncher(prepared, attach).up()).rejects.toThrow("already used by PID 701");
  expect(attach.starts).toEqual([]);

  const value = await plan();
  const owner = new FakeServices(value);
  owner.seed("emulator");
  // down must discover the actual port even if ludens.json has since changed.
  owner.bridgePort = 47999;
  owner.bridgeClientPids = [701];
  await expect(new WorkspaceLauncher(value, owner).down(false)).rejects.toThrow("bridge client from another Baseware service");
  expect(owner.jobs.has(owner.target("emulator"))).toBe(true);
  expect(owner.calls.some(argv => argv[2] === "--stop")).toBe(false);
});

test("a connected Baseware service is reused without probing its occupied emulator bridge", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  io.externalBaseware = true;
  io.externalEmulator = true;
  io.bridgeClientPids = [701];
  const status = await new WorkspaceLauncher(value, io).up();
  expect(status.baseware?.connected).toBe(true);
  expect(io.starts).toEqual(["host", "dashboard", "pet"]);
  expect(io.calls.some(argv => argv[0] === "pgrep" || (argv[0] === "lsof" && argv.includes(`-iTCP:${value.config.port}`)))).toBe(false);
});

test("a failed or disconnected Baseware service never starts the Ludens host", async () => {
  const value = await plan();
  const failed = new FakeServices(value);
  failed.failStart = "baseware";
  await expect(new WorkspaceLauncher(value, failed).up()).rejects.toThrow("baseware unavailable");
  expect(failed.starts).toEqual(["emulator", "baseware"]);
  expect(failed.jobs.has(failed.target("emulator"))).toBe(true);

  const disconnected = new FakeServices(value);
  disconnected.seed("baseware");
  disconnected.basewareConnected = false;
  await expect(new WorkspaceLauncher(value, disconnected).up()).rejects.toThrow("Baseware is alive but its device is disconnected");
  expect(disconnected.starts).toEqual([]);
});

test("down preserves Baseware and its emulator while an unmanaged host or lease still owns them", async () => {
  const value = await plan();
  for (const owner of ["host", "lease"] as const) {
    const io = new FakeServices(value);
    io.seed("baseware");
    io.seed("emulator");
    io.externalHost = owner === "host";
    io.basewareMode = owner === "lease" ? "auto" : "manual";
    await expect(new WorkspaceLauncher(value, io).down(false)).rejects.toThrow(owner === "host" ? "unmanaged host" : "active owner");
    expect(io.calls.some(argv => argv[2] === "--stop")).toBe(false);
  }
});

test("a package-linked CLI initializes a workspace through mixed symlink chains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens linked cli "));
  try {
    const home = join(directory, "home"), workspace = join(directory, "workspace with spaces");
    await symlink(resolve(import.meta.dir, "../bin/ludens"), join(directory, "absolute-cli"));
    await symlink("absolute-cli", join(directory, "ludens"));
    const env: NodeJS.ProcessEnv = { ...process.env, LUDENS_HOME: home };
    delete env.LUDENS_WORKSPACE; delete env.LUDENS_SOCKET; delete env.BASEWARE_SOCKET;
    const child = Bun.spawn([join(directory, "ludens"), "init", "--workspace", workspace, "--driver", "cua"], {
      cwd: directory, env, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(0);
    const created = JSON.parse(stdout);
    expect(created.workspace).toBe(await realpath(workspace));
    expect(JSON.parse(await readFile(created.configPath, "utf8")).driver).toBe("cua");
    expect(JSON.parse(await readFile(join(workspace, ".ludens/workspace.json"), "utf8")).id).toBe(created.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Baseware machine bindings validate and persist across registry and workspace updates", async () => {
  expect(parseConfig({
    driver: "cua",
    machines: { active: "local-desktop", allowed: ["local-desktop"] },
  }, manifestFor("cua")).machines).toEqual({ active: "local-desktop", allowed: ["local-desktop"] });
  expect(() => parseConfig({ driver: "cua", machines: { allowed: ["bad id"] } }, manifestFor("cua"))).toThrow("machines.allowed");

  const directory = await mkdtemp(join(tmpdir(), "ludens-baseware-machines-"));
  const home = join(directory, "home");
  const workspace = join(directory, "workspace");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "ludens.json"), JSON.stringify({ driver: "cua", model: "openai-codex/gpt-6.1-sol" }, null, 2));
    await ensureWorkspaceIdentity(workspace);
    const entry = await registerWorkspace(workspace, home);

    const upserted = await upsertBasewareMachine({
      id: "test-machine",
      name: "Test Machine",
      driver: "bridge-fixture",
      transport: { kind: "bridge", host: "127.0.0.1", port: 47991 },
    }, home);
    expect(upserted.machine.id).toBe("test-machine");
    expect(upserted.machines.map(machine => machine.id)).toEqual(["local-desktop", "test-machine"]);

    const initial = await basewareOverview(entry.id, home);
    expect(initial.workspaceId).toBe(entry.id);
    expect(initial.binding).toEqual({ active: "local-desktop", allowed: ["local-desktop"] });
    expect(initial.implicitMachine).toBeNull();
    expect(initial.activeMachine?.id).toBe("local-desktop");
    expect(initial.machines.find(machine => machine.id === "local-desktop")?.usedByWorkspaceIds).toEqual([entry.id]);

    const updated = await updateWorkspaceMachines(entry.id, { active: "test-machine", allowed: ["test-machine"] }, home);
    expect(updated.binding).toEqual({ active: "test-machine", allowed: ["test-machine"] });
    expect(updated.activeMachine?.id).toBe("test-machine");
    expect(updated.machines.find(machine => machine.id === "test-machine")?.usedByWorkspaceIds).toEqual([entry.id]);
    expect(JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8")).machines).toEqual(updated.binding);

    const removed = await removeBasewareMachine("test-machine", home);
    expect(removed.removed?.id).toBe("test-machine");
    expect(removed.machines.map(machine => machine.id)).toEqual(["local-desktop"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("model connection config validates, merges, maps to OMP isolated settings, and persists at global and workspace scopes", async () => {
  expect(validateConnectionConfig({
    openaiWebsockets: "off",
    cacheRetention: "long",
    appendOnlyContext: "on",
    imageUrls: { enabled: true, backends: ["uguu", "tmpfiles", "uguu"] },
  })).toEqual({
    openaiWebsockets: "off",
    cacheRetention: "long",
    appendOnlyContext: "on",
    imageUrls: { enabled: true, backends: ["uguu", "tmpfiles"] },
  });

  expect(() => validateConnectionConfig({ openaiWebsockets: "invalid" })).toThrow("openaiWebsockets must be one of");
  expect(() => validateConnectionConfig({ imageUrls: { backends: ["not-a-backend"] } })).toThrow("imageUrls.backends must be an array of supported backends");

  const merged = mergeConnectionConfig(
    { openaiWebsockets: "auto", cacheRetention: "short", imageUrls: { enabled: false, backends: ["uguu"] } },
    { cacheRetention: "long", appendOnlyContext: "on", imageUrls: { enabled: true } },
  );
  expect(merged).toEqual({
    openaiWebsockets: "auto",
    cacheRetention: "long",
    appendOnlyContext: "on",
    imageUrls: { enabled: true, backends: ["uguu"] },
  });

  expect(ompSettingsOverrides({ compactionThreshold: 64000, connection: merged })).toEqual({
    "tier.openai": "none",
    "title.refreshOnReplan": false,
    "retry.modelFallback": false,
    "compaction.thresholdTokens": 64000,
    "providers.openaiWebsockets": "auto",
    "providers.cacheRetention": "long",
    "provider.appendOnlyContext": "on",
    "images.urls.enabled": true,
    "images.urls.backends": ["uguu"],
  });

  const parsed = parseConfig({
    driver: "cua",
    connection: {
      openaiWebsockets: "on",
      cacheRetention: "long",
      appendOnlyContext: "on",
      imageUrls: { enabled: true, backends: ["uguu", "tmpfiles"] },
    },
  }, manifestFor("cua"));
  expect(parsed.connection).toEqual({
    openaiWebsockets: "on",
    cacheRetention: "long",
    appendOnlyContext: "on",
    imageUrls: { enabled: true, backends: ["uguu", "tmpfiles"] },
  });
  expect(parseConfig({ driver: "cua", serviceTier: "ultrafast" }, manifestFor("cua")).serviceTier).toBe("ultrafast");
  expect(() => parseConfig({ driver: "cua", serviceTier: "invalid" }, manifestFor("cua"))).toThrow("serviceTier");
  expect(parseConfig({ driver: "cua", effort: "xhigh" }, manifestFor("cua")).effort).toBe("xhigh");
  expect(() => parseConfig({ driver: "cua", effort: "invalid" }, manifestFor("cua"))).toThrow("effort");

  const directory = await mkdtemp(join(tmpdir(), "ludens-connection-config-"));
  const home = join(directory, "home");
  const wsDir = join(directory, "conn-ws");
  try {
    const globalResult = await updateGlobalConnection({
      openaiWebsockets: "auto",
      cacheRetention: "long",
      appendOnlyContext: "on",
      imageUrls: { enabled: true, backends: ["uguu", "tmpfiles"] },
    }, home);
    expect(globalResult.config.defaults.connection).toEqual({
      openaiWebsockets: "auto",
      cacheRetention: "long",
      appendOnlyContext: "on",
      imageUrls: { enabled: true, backends: ["uguu", "tmpfiles"] },
    });

    await mkdir(wsDir, { recursive: true });
    await writeFile(join(wsDir, "ludens.json"), JSON.stringify({ driver: "cua", model: "openai-codex/gpt-6.1-sol" }, null, 2));
    await ensureWorkspaceIdentity(wsDir);
    const entry = await registerWorkspace(wsDir, home);

    const initialSnap = await workspaceConnection(entry.id, home);
    expect(initialSnap.connection).toEqual({});
    expect(initialSnap.defaults).toEqual({
      openaiWebsockets: "auto",
      cacheRetention: "long",
      appendOnlyContext: "on",
      imageUrls: { enabled: true, backends: ["uguu", "tmpfiles"] },
    });

    const updatedSnap = await updateWorkspaceConnection(entry.id, {
      openaiWebsockets: "off",
      imageUrls: { enabled: false },
    }, home);
    expect(updatedSnap.connection).toEqual({
      openaiWebsockets: "off",
      imageUrls: { enabled: false },
    });
    expect(mergeConnectionConfig(updatedSnap.defaults, updatedSnap.connection)).toEqual({
      openaiWebsockets: "off",
      cacheRetention: "long",
      appendOnlyContext: "on",
      imageUrls: { enabled: false, backends: ["uguu", "tmpfiles"] },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("petLaunchCommand uses POSIX launcher on darwin/linux and electron.exe on win32", () => {
  expect(petLaunchCommand("/repo", "/ws", "darwin")).toEqual([
    "/repo/app/bin/ludens-app",
    "--workspace",
    "/ws",
    "--show-window",
  ]);
  expect(petLaunchCommand("/repo", "/ws", "linux")).toEqual([
    "/repo/app/bin/ludens-app",
    "--workspace",
    "/ws",
    "--show-window",
  ]);
  expect(petLaunchCommand("C:\\repo", "C:\\ws", "win32")).toEqual([
    join("C:\\repo", "app/node_modules/electron/dist/electron.exe"),
    join("C:\\repo", "app/dist/electron/main.js"),
    "--workspace",
    "C:\\ws",
    "--show-window",
  ]);
});
