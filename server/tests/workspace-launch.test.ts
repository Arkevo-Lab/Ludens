import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSystemLaunchIO, launchPlan, parseConfig, petLaunchCommand, WorkspaceLauncher, type DriverManifest, type LaunchIO, type LaunchPlan } from "../src/daemon/launcher.ts";
import { stopLocalAppDaemon } from "../src/daemon/app-daemon.ts";
import { cliCommand } from "../src/daemon/background-jobs.ts";
import { resolveCommandAndEnv } from "../src/daemon/process-manager.ts";
import { WorkspaceSupervisor } from "../src/daemon/supervisor.ts";
import { defaultDriverCacheRoot, resolveDriver } from "@ludens/baseware/drivers/loader.ts";
import { getDriver } from "@ludens/baseware/drivers/registry.ts";
import { ensureWorkspaceIdentity, ludensHome, mergeConnectionConfig, registerWorkspace, validateConnectionConfig } from "@ludens/protocol/ludens";
import { ompSettingsOverrides } from "@ludens/core/core/agent-omp/models";
import { initializeWorkspace } from "../src/query/workspace-init.ts";
import {
  updateGlobalConnection,
  updateWorkspaceConnection,
  workspaceConnection,
  upsertBasewareMachine,
  basewareOverview,
  updateWorkspaceMachines,
  removeBasewareMachine,
} from "../src/query/workspaces.ts";

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
const ludensCommand = (repo: string) => process.platform === "win32"
  ? [process.execPath, resolve(repo, "core/src/cli/main.ts")]
  : [join(repo, "core/bin/ludens-core")];
const basewareCommand = (repo: string) => process.platform === "win32"
  ? [process.execPath, resolve(repo, "baseware/src/main.ts")]
  : [join(repo, "baseware/bin/baseware")];

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
    for (const name of ["emulator", "baseware", "host", "pet"] as const) {
      if (this.stateFile(name) === path) return this.target(name);
    }
    return path;
  }
  seed(name: string) { this.jobs.set(this.target(name), 100 + this.jobs.size); }
  petReady = async () => this.externalPet || (this.jobs.has(this.target("pet")) && this.clock >= this.petReadyAfter);
  sleep = async () => { this.clock += 500; };
  now = () => this.clock;
  note = () => {};
  async run(argv: string[], cwd: string) {
    const sharedPetLaunch = argv[0] === process.execPath && argv[2] === "--label";
    expect(cwd).toBe(sharedPetLaunch ? this.plan.sharedPet.cwd : this.plan.workspace);
    this.calls.push([...argv]);
    const result = (stdout = "", code = 0, stderr = "") => ({ code, stdout, stderr });
    if (argv[0] === "env" && argv.slice(2).join("\0") === [...cliCommand(this.plan.baseware), "status"].join("\0")) {
      expect(argv[1]).toBe(`BASEWARE_SOCKET=${this.plan.basewareSocket}`);
      if (!this.jobs.has(this.target("baseware")) && !this.externalBaseware) return result("", 1);
      this.events.push(`baseware:${this.basewareMode}:${this.basewareConnected}`);
      return result(JSON.stringify({ serviceId: "device-session", mode: this.basewareMode,
        connected: this.basewareConnected, epoch: this.basewareMode === "auto" ? "another-owner" : null }));
    }
    if (argv.join("\0") === [...cliCommand(this.plan.ludens), "status"].join("\0")) {
      if (!this.jobs.has(this.target("host")) && !this.externalHost) return result("", 1);
      const thinking = this.cleanupReads-- > 0;
      this.events.push(`host:${this.mode}:${thinking}`);
      return result(JSON.stringify({ runId: "original-session", mode: this.mode, connected: true,
        thinking, consolidating: false, timerSeconds: null }));
    }
    if (argv.join("\0") === [...cliCommand(this.plan.ludens), "auto", "off"].join("\0")) {
      this.events.push("auto off");
      this.mode = "manual";
      this.basewareMode = "manual";
      this.cleanupReads = 2;
      return result();
    }
    if (argv[0] === process.execPath && argv[1] === this.plan.launcher && argv[2] === "--status") {
      const pid = this.jobs.get(this.targetForStateFile(argv[3]!));
      return result(JSON.stringify(pid
        ? { registered: true, pid, state: "running", lastExitCode: null }
        : { registered: false, pid: null, state: null, lastExitCode: null }));
    }
    if (argv[0] === process.execPath && argv[1] === this.plan.launcher && argv[2] === "--stop") {
      const target = this.targetForStateFile(argv[3]!);
      this.events.push(`stop:${target}`);
      this.jobs.delete(target);
      return result();
    }
    if (argv[0] === process.execPath && argv[1] === this.plan.launcher) {
      const nameIndex = sharedPetLaunch ? 6 : 2;
      const name = argv[nameIndex]!;
      this.starts.push(name);
      if (sharedPetLaunch) expect(argv.slice(2, 6)).toEqual(["--label", "dev.ludens.pet", "--log-dir", this.plan.sharedPet.background]);
      expect(argv.slice(nameIndex + 1)).toEqual(this.plan.commands[name as keyof typeof this.plan.commands]!);
      if (name === this.failStart) return result("", 1, `${name} unavailable`);
      if (name === "host") expect(this.events).toContain("baseware:manual:true");
      this.seed(name);
      return result();
    }
    if (argv[0] === "netstat") {
      const rows = ["Active Connections", "  Proto  Local Address  Foreign Address  State  PID"];
      if (this.externalEmulator) {
        rows.push("  TCP  127.0.0.1:49100  0.0.0.0:0  LISTENING  999");
        rows.push("  TCP  127.0.0.1:51010  127.0.0.1:49100  ESTABLISHED  998");
      }
      const pid = this.jobs.get(this.target("emulator")) ?? this.preparedBridgePid;
      if (pid && this.bridgePort) {
        rows.push(`  TCP  127.0.0.1:51100  192.0.2.1:${this.bridgePort}  ESTABLISHED  998`);
        const address = `127.0.0.1:${this.bridgePort}`;
        rows.push(`  TCP  ${address}  0.0.0.0:0  LISTENING  ${pid}`);
        const baseware = this.jobs.get(this.target("baseware"));
        const clients = [...this.bridgeClientPids, ...(baseware ? [baseware] : [])];
        clients.forEach((client, index) => {
          const clientAddress = `127.0.0.1:${51000 + index}`;
          rows.push(`  TCP  ${address}  ${clientAddress}  ESTABLISHED  ${pid}`);
          rows.push(`  TCP  ${clientAddress}  ${address}  ESTABLISHED  ${client}`);
        });
      }
      return result(rows.join("\r\n"));
    }
    if (argv[0] === "lsof") {
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

test("up rejects unidentified and conflicting workspaces before loading drivers", async () => {
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
    const supervisor = new WorkspaceSupervisor({ home });
    try {
      await expect(supervisor.up(copy)).rejects.toThrow("--new-id");
      await expect(supervisor.up(legacy)).rejects.toThrow("workspace import");
    } finally {
      await supervisor.shutdownAll({ emergency: true });
    }
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await readdir(legacy)).toEqual(["ludens.json"]);
    expect(await readFile(join(home, "registry", `${identity.id}.json`), "utf8")).toBe(registration);
  } finally {
    await stopLocalAppDaemon(join(directory, "global"), { stopCores: true }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("default workspace startup starts Baseware and host without launching or waiting for Electron", async () => {
  const config = parseConfig({ driver: "cua" }, manifestFor("cua"));
  expect(config).toMatchObject({ pet: false });
  expect("dashboard" in config).toBe(false);
  const value = await launchPlan(config, "/tmp/Web workspace", "/tmp/Source", "/tmp/web-baseware.sock", manifestFor("cua"));
  expect(value.commands.pet).toBeUndefined();
  const io = new FakeServices(value);
  io.petReadyAfter = Infinity;
  const launcher = new WorkspaceLauncher(value, io);
  await launcher.up();
  expect(io.starts).toEqual(["baseware", "host"]);
  expect(io.clock).toBe(0);
  // Disabling startup must also leave a Pet opened by another workspace alone.
  io.seed("pet");
  await launcher.up();
  expect(io.jobs.has(io.target("pet"))).toBe(true);
  expect(io.calls.some(argv => argv[2] === "--stop")).toBe(false);
});

test("system Pet readiness uses the pet/getState RPC method", async () => {
  const methods: string[] = [];
  let connected = true;
  let failGetState = false;
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      if (new URL(request.url).pathname === "/rpc" && bunServer.upgrade(request)) {
        return;
      }
      return new Response("missing", { status: 404 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as { id: number; method: string };
        methods.push(msg.method);
        if (msg.method === "initialize") {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              serverVersion: "test",
              pid: process.pid,
              home: ludensHome(),
              transport: "ws",
              authenticated: true,
              runtimeProfile: "remote",
              capabilities: {
                localFsPaths: false,
                localFileDrivers: false,
                hostProcessOverrides: false,
                hostStorageConfig: false,
              },
              serverSeq: 0,
              activeCoreCount: 0,
              managedWorkspaces: [],
              media: { basePath: "/media", liveStreamCapabilities: ["none"] },
            },
          }));
          return;
        }
        if (msg.method === "pet/getState") {
          if (failGetState) {
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "unavailable" } }));
            return;
          }
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { connected } }));
        }
      },
    },
  });
  const io = new WorkspaceLauncher(await plan())["io"];
  try {
    expect(await io.petReady(server.url.origin)).toBe(true);
    connected = false;
    expect(await io.petReady(server.url.origin)).toBe(false);
    connected = true;
    failGetState = true;
    expect(await io.petReady(server.url.origin)).toBe(false);
    expect(methods).toEqual(["initialize", "pet/getState", "initialize", "pet/getState", "initialize", "pet/getState"]);
  } finally {
    server.stop(true);
  }
});

test("legacy dashboard field in ludens.json is silently stripped without exposing a dashboard service", async () => {
  const legacyTrue = parseConfig({ driver: "cua", dashboard: true }, manifestFor("cua"));
  const legacyFalse = parseConfig({ driver: "cua", dashboard: false }, manifestFor("cua"));
  expect("dashboard" in legacyTrue).toBe(false);
  expect("dashboard" in legacyFalse).toBe(false);
  const value = await launchPlan(legacyTrue, "/tmp/Workspace with spaces", "/tmp/Source with spaces", "/tmp/baseware-test.sock", manifestFor("cua"));
  expect(Object.keys(value.commands)).toEqual(["baseware", "host"]);
});

test("launch config keeps limits explicit and paths as literal argv entries", async () => {
  const value = await plan();
  expect(value.config).toMatchObject({ port: 47991 });
  expect(value.commands.host).not.toContain("--seconds");
  expect(value.commands.host).not.toContain("--requests");
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
    resolve(value.workspace, "games/A game; $(touch BAD).rom")]);
  expect(value.commands.baseware).toEqual([...basewareCommand("/tmp/Source with spaces"), "serve",
    "--driver", "bridge-fixture", "--port", "47991", "--socket", "/tmp/baseware-test.sock",
    "--data-dir", join(value.workspace, "logs", "baseware"), "--diagnostics", "normal"]);
  const hostCommand = ludensCommand("/tmp/Source with spaces");
  expect(value.commands.host!.slice(0, hostCommand.length + 1)).toEqual([...hostCommand, "run"]);
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
  const { command, extraEnv } = resolveCommandAndEnv(value.commands.emulator!);
  expect(command).toEqual(["fixture-emulator", resolve(value.workspace, "game.rom")]);
  const child = Bun.spawn([process.execPath, "-e",
    "process.stdout.write(JSON.stringify([process.env.LUDENS_BRIDGE_PORT, process.env.FIXTURE_OPTION]))"],
    { env: { ...process.env, ...extraEnv }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  const [backendPort, option] = JSON.parse(await new Response(child.stdout).text());
  expect(backendPort).toBe("47993");
  expect(option).toBe("kept");
  expect(value.commands.baseware![value.commands.baseware!.indexOf("--port") + 1]).toBe(backendPort);
});

test("Cua launch config uses its native service without choosing a workspace observation", async () => {
  const config = parseConfig({ driver: "cua", cuaCommand: "/Applications/Cua Driver/cua-driver", pet: false }, manifestFor("cua"));
  const value = await launchPlan(config, "/tmp/Desktop workspace", "/tmp/Source", "/tmp/cua-baseware.sock", manifestFor("cua"));
  expect(config.port).toBeUndefined();
  expect(value.commands.emulator).toBeUndefined();
  expect(value.commands.baseware).toEqual([...basewareCommand("/tmp/Source"), "serve", "--driver", "cua",
    "--cua-command", "/Applications/Cua Driver/cua-driver", "--socket", "/tmp/cua-baseware.sock",
    "--data-dir", join(value.workspace, "logs", "baseware"), "--diagnostics", "normal"]);
  expect(value.commands.host).not.toContain("--auto-observe");
  const defaults = await launchPlan(parseConfig({ driver: "cua" }, manifestFor("cua")), "/tmp/Desktop workspace", "/tmp/Source", "/tmp/cua-baseware.sock", manifestFor("cua"));
  expect(defaults.commands.baseware).not.toContain("--cua-command");
  expect(defaults.commands.baseware).not.toContain("--port");
  expect(() => parseConfig({ driver: "cua", port: 47991 }, manifestFor("cua"))).toThrow("bridge port");
  expect(() => parseConfig({ driver: "cua", game: "game.rom" }, manifestFor("cua"))).toThrow("game");
  expect(() => parseConfig({ driver: "prepared-fixture", cuaCommand: "cua-driver" }, manifestFor("prepared-fixture"))).toThrow("cuaCommand");
});

test("Cua startup and shutdown only manage its services, without emulator bridge probes", async () => {
  const value = await launchPlan(parseConfig({ driver: "cua", pet: false }, manifestFor("cua")), "/tmp/Desktop workspace", "/tmp/Source", "/tmp/cua-baseware.sock", manifestFor("cua"));
  const io = new FakeServices(value);
  const launcher = new WorkspaceLauncher(value, io);
  const status = await launcher.up();
  expect(status.host?.mode).toBe("manual");
  expect(io.starts).toEqual(["baseware", "host"]);
  await launcher.up();
  expect(io.starts).toEqual(["baseware", "host"]);
  await launcher.down();
  expect(io.calls.filter(argv => argv[2] === "--stop").map(argv => io.targetForStateFile(argv[3]!))).toEqual(
    ["host", "baseware"].map(name => io.target(name)));
  expect(io.calls.some(argv => ["lsof", "netstat", "ss"].includes(argv[0]!))).toBe(false);
});

test.skipIf(process.platform !== "win32")("Windows launch commands execute without POSIX shell wrappers", async () => {
  const repo = resolve(import.meta.dir, "../..");
  const value = await launchPlan(parseConfig({ driver: "cua" }, manifestFor("cua")), repo, repo, undefined, manifestFor("cua"));
  const io = createSystemLaunchIO();
  const [host, baseware] = await Promise.all([
    io.run([...value.commands.host!.slice(0, value.commands.host!.indexOf("run")), "--help"], repo),
    io.run([...value.commands.baseware!.slice(0, value.commands.baseware!.indexOf("serve")), "--help"], repo),
  ]);
  expect(host.code, host.stderr).toBe(0);
  expect(host.stdout).toContain("Workspace startup:");
  expect(baseware.code, baseware.stderr).toBe(0);
  expect(baseware.stdout).toContain("baseware serve");
});

test("an external bridge manifest launches its device without desktop dependencies", async () => {
  const config = parseConfig({ driver: "dual-fixture", game: "games/Dual game.rom" }, manifestFor("dual-fixture"));
  const value = await launchPlan(config, "/tmp/Dual workspace", "/tmp/Source", "/tmp/dual-baseware.sock", manifestFor("dual-fixture"));
  expect(config.port).toBe(47992);
  expect(value.commands.emulator).toEqual(["env", "LUDENS_BRIDGE_PORT=47992",
    "/fixture/Dual.app/Contents/MacOS/dual", resolve(value.workspace, "games/Dual game.rom")]);
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
    const home = join(directory, "global");
    const workspace = join(directory, "Workspace ; $ literal");
    await mkdir(workspace);
    await writeFile(join(workspace, "AGENTS.md"), "My existing workspace instructions\n");
    const packagePath = join(directory, "external-driver.ts");
    await writeFile(packagePath, `export default { ...${JSON.stringify(fixtureManifests["bridge-fixture"])}, load() { throw new Error("init must not load the provider"); } };`);

    await initializeWorkspace(
      {
        name: "literal",
        workspace,
        driver: "bridge-fixture",
        driverPackage: `file:${packagePath}`,
        game: "games/Uninstalled ; $ game.rom",
      },
      { home },
    );
    const configBefore = await readFile(join(workspace, "ludens.json"), "utf8");
    const manifest = await resolveDriver("bridge-fixture", `file:${packagePath}`, defaultDriverCacheRoot());
    const parsedConfig = parseConfig(JSON.parse(configBefore), manifest);
    const preview = await launchPlan(parsedConfig, await realpath(workspace), undefined, undefined, manifest);
    expect(preview).toMatchObject({ workspace: await realpath(workspace), config: { pet: false } });
    expect(preview.commands.pet).toBeUndefined();
    const withPet = await launchPlan({ ...parsedConfig, pet: true }, await realpath(workspace), undefined, undefined, manifest);
    expect(withPet.commands.pet).toBeDefined();

    await expect(initializeWorkspace({ name: "literal", workspace, driver: "cua" }, { home })).rejects.toThrow(/EEXIST|已存在/);
    expect(await readFile(join(workspace, "ludens.json"), "utf8")).toBe(configBefore);
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe("My existing workspace instructions\n");
    expect((await readdir(workspace)).sort()).toEqual([".ludens", "AGENTS.md", "ludens.json", "perception.py"]);
    expect(await readFile(join(workspace, "perception.py"), "utf8")).toContain("NotImplementedError");

    const desktop = join(directory, "Desktop workspace");
    await initializeWorkspace(
      { name: "desktop", workspace: desktop, driver: "cua", cuaCommand: "./tools/cua-driver", pet: true },
      { home },
    );
    const desktopConfig = parseConfig(JSON.parse(await readFile(join(desktop, "ludens.json"), "utf8")), manifestFor("cua"));
    const desktopPreview = await launchPlan(desktopConfig, await realpath(desktop), undefined, undefined, manifestFor("cua"));
    expect(desktopPreview).toMatchObject({ config: { driver: "cua", cuaCommand: "./tools/cua-driver", pet: true } });
    expect(desktopPreview.commands.emulator).toBeUndefined();
    expect(desktopPreview.commands.pet).toBeDefined();
    const webOnly = await launchPlan({ ...desktopConfig, pet: false }, await realpath(desktop), undefined, undefined, manifestFor("cua"));
    expect(webOnly.commands.pet).toBeUndefined();
    expect(JSON.parse(await readFile(join(desktop, "ludens.json"), "utf8")).pet).toBe(true);
  } finally {
    await stopLocalAppDaemon(join(directory, "global"), { stopCores: true }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("external packages resolve workspace-relative file specs and check only executable argv", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-package-launch-"));
  const previousPath = process.env.PATH;
  try {
    const home = join(directory, "global");
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
    await initializeWorkspace(
      { name: "pkg-ws", workspace, driver: "fixture", driverPackage: "file:./driver", game: "game.rom" },
      { home },
    );
    const config = JSON.parse(await readFile(join(workspace, "ludens.json"), "utf8"));
    expect(config.driverPackage).toBe("file:./driver");
    await writeFile(join(workspace, "ludens.json"), JSON.stringify({ ...config, driverPackage: "file:./driver", pet: false }));
    const canonicalWs = await realpath(workspace);
    const resolvedDriver = `file:${join(canonicalWs, "driver")}`;
    const manifest = await resolveDriver("fixture", resolvedDriver, defaultDriverCacheRoot());
    const previewPlan = await launchPlan(parseConfig({ ...config, driverPackage: "file:./driver", pet: false }, manifest), canonicalWs, undefined, undefined, manifest);
    expect(previewPlan.commands.baseware).toContain(`file:${await realpath(driver)}`);
    expect(previewPlan.commands.emulator).toEqual(["env", "LUDENS_BRIDGE_PORT=47991", "fixture-emulator", "--headless", "literal argument", join(canonicalWs, "game.rom")]);
    if (process.platform !== "win32") {
      process.env.PATH = bin;
      const supervisor = new WorkspaceSupervisor({ home });
      try {
        await expect(supervisor.up(workspace)).rejects.toThrow("emulator exited");
        expect(await readFile(join(workspace, "logs/background/emulator.log"), "utf8")).toContain("launch-stopped");
        await chmod(join(bin, "fixture-emulator"), 0o644);
        await expect(supervisor.up(workspace)).rejects.toThrow("Missing executable fixture-emulator");
      } finally {
        await supervisor.shutdownAll({ emergency: true });
      }
    }
  } finally {
    process.env.PATH = previousPath;
    await stopLocalAppDaemon(join(directory, "global"), { stopCores: true }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("failed startup preserves ready services and repeated up resumes without duplicate hosts or takeover", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  const launcher = new WorkspaceLauncher(value, io);
  io.failStart = "pet";
  await expect(launcher.up()).rejects.toThrow("pet unavailable");
  expect(io.jobs.has(io.target("host"))).toBe(true);
  expect(io.jobs.has(io.target("emulator"))).toBe(true);
  io.failStart = null;
  const recovered = await launcher.up();
  expect(recovered.host?.mode).toBe("manual");
  await launcher.up();
  expect(io.starts).toEqual(["emulator", "baseware", "host", "pet", "pet"]);
  expect(recovered.baseware).toMatchObject({ connected: true, serviceId: "device-session" });
  expect(io.calls.some(argv => argv[1] === "auto")).toBe(false);
  expect(io.calls.some(argv => argv[2] === "--stop")).toBe(false);
});

test("down waits for takeover cleanup, stops only owned jobs, and keeps the shared Pet", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  for (const name of ["host", "baseware", "emulator", "pet"]) io.seed(name);
  const foreign = "dev.ludens.core.another-workspace.host";
  io.jobs.set(foreign, 999);
  io.mode = "auto";
  io.basewareMode = "auto";
  await new WorkspaceLauncher(value, io).down();
  const stopHost = io.events.indexOf(`stop:${io.target("host")}`);
  expect(io.events.indexOf("auto off")).toBeLessThan(stopHost);
  expect(io.events.indexOf("host:manual:false")).toBeGreaterThan(io.events.indexOf("auto off"));
  expect(io.events.indexOf("host:manual:false")).toBeLessThan(stopHost);
  expect(io.calls.filter(argv => argv[2] === "--stop").map(argv => io.targetForStateFile(argv[3]!))).toEqual(
    ["host", "baseware", "emulator"].map(name => io.target(name)));
  expect([...io.jobs.keys()]).toEqual([io.target("pet"), foreign]);

  const keep = new FakeServices(value);
  for (const name of ["host", "baseware", "emulator", "pet"]) keep.seed(name);
  await new WorkspaceLauncher(value, keep).down(true);
  expect(keep.calls.filter(argv => argv[2] === "--stop").map(argv => keep.targetForStateFile(argv[3]!))).toEqual(
    ["host", "baseware"].map(name => keep.target(name)));
  expect([...keep.jobs.keys()]).toEqual([keep.target("emulator"), keep.target("pet")]);
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
  const secondLauncher = new WorkspaceLauncher(second, secondIO);
  const secondStatus = await secondLauncher.up();
  expect(secondIO.starts).toEqual(["baseware", "host"]);
  expect(secondStatus.jobs.find(job => job.name === "pet")).toEqual(firstPet);
  expect(secondIO.calls.some(argv => argv.includes("--workspace"))).toBe(false);

  await secondLauncher.down();
  expect(secondIO.jobs.get(secondIO.target("pet"))).toBe(firstPet.pid!);
  await secondLauncher.down(true, true);
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
  await launcher.down(true, true);
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
    const script = resolve(import.meta.dir, "../src/daemon/process-manager.ts");

    const child = Bun.spawn([
      process.execPath, script, "--label", "dev.ludens.pet", "--log-dir", logs, "pet",
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
      const check = Bun.spawn([process.execPath, script, "--status", stateFile], { stdout: "pipe", stderr: "pipe" });
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
    const cleanup = Bun.spawn([process.execPath, script, "--stop", stateFile], { stdout: "pipe", stderr: "pipe" });
    expect(await cleanup.exited).toBe(0);
    expect(await Bun.file(stateFile).exists()).toBe(false);

    const grandchildPidFile = join(directory, "grandchild.pid");
    const sleeper = Bun.spawn([
      process.execPath, script, "--label", "dev.ludens.pet", "--log-dir", logs, "pet",
      process.execPath, "-e",
      `const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const sub = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" }); writeFileSync(${JSON.stringify(grandchildPidFile)}, String(sub.pid)); setInterval(() => {}, 1000);`,
    ], { cwd: stableCwd, stdout: "pipe", stderr: "pipe" });
    expect(await sleeper.exited).toBe(0);
    const sleeperInfo = JSON.parse(await new Response(sleeper.stdout).text()) as { pid: number };
    expect(sleeperInfo.pid).toBeGreaterThan(0);

    let grandchildPid = 0;
    for (let i = 0; i < 40; i++) {
      if (await Bun.file(grandchildPidFile).exists()) {
        grandchildPid = Number((await readFile(grandchildPidFile, "utf8")).trim());
        if (grandchildPid > 0) break;
      }
      await Bun.sleep(50);
    }
    expect(grandchildPid).toBeGreaterThan(0);

    const stopLive = Bun.spawn([process.execPath, script, "--stop", stateFile], { stdout: "pipe", stderr: "pipe" });
    expect(await stopLive.exited).toBe(0);
    expect(await Bun.file(stateFile).exists()).toBe(false);
    expect(() => process.kill(sleeperInfo.pid, 0)).toThrow();
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(grandchildPid, 0);
        await Bun.sleep(50);
      } catch {
        break;
      }
    }
    expect(() => process.kill(grandchildPid, 0)).toThrow();
    expect(await readdir(stableCwd)).toEqual([]);
  } finally {
    await stopLocalAppDaemon(join(directory, "global"), { stopCores: true }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("another emulator process on a different port does not block multi-core startup", async () => {
  const value = await plan();
  const io = new FakeServices(value);
  io.externalEmulator = true;
  expect((await new WorkspaceLauncher(value, io).up()).host?.mode).toBe("manual");
  expect(io.starts).toContain("emulator");
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
  await expect(new WorkspaceLauncher(value, owner).down()).rejects.toThrow("bridge client from another Baseware service");
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
  expect(io.starts).toEqual(["host", "pet"]);
  expect(io.calls.some(argv => ["lsof", "netstat", "ss"].includes(argv[0]!))).toBe(false);
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
    await expect(new WorkspaceLauncher(value, io).down()).rejects.toThrow(owner === "host" ? "unmanaged host" : "active owner");
    expect(io.calls.some(argv => argv[2] === "--stop")).toBe(false);
  }
});

test.skipIf(process.platform === "win32")("the POSIX package launchers resolve cleanly through mixed symlink chains", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens linked cli "));
  try {
    const home = join(directory, "home");
    await symlink(resolve(import.meta.dir, "../bin/ludens-server"), join(directory, "absolute-server-cli"));
    await symlink("absolute-server-cli", join(directory, "ludens-server"));
    await symlink(resolve(import.meta.dir, "../../core/bin/ludens-core"), join(directory, "absolute-core-cli"));
    await symlink("absolute-core-cli", join(directory, "ludens-core"));
    const env: NodeJS.ProcessEnv = { ...process.env, LUDENS_HOME: home };
    delete env.LUDENS_WORKSPACE; delete env.LUDENS_SOCKET; delete env.BASEWARE_SOCKET;

    const serverChild = Bun.spawn([join(directory, "ludens-server"), "status"], {
      cwd: directory, env, stdout: "pipe", stderr: "pipe",
    });
    const [serverCode, serverStdout, serverStderr] = await Promise.all([
      serverChild.exited, new Response(serverChild.stdout).text(), new Response(serverChild.stderr).text(),
    ]);
    expect(serverCode, serverStderr).toBe(0);
    expect(JSON.parse(serverStdout)).toMatchObject({ running: false, home: resolve(home) });

    const coreChild = Bun.spawn([join(directory, "ludens-core"), "--help"], {
      cwd: directory, env, stdout: "pipe", stderr: "pipe",
    });
    const [coreCode, coreStdout, coreStderr] = await Promise.all([
      coreChild.exited, new Response(coreChild.stdout).text(), new Response(coreChild.stderr).text(),
    ]);
    expect(coreCode, coreStderr).toBe(0);
    expect(coreStdout).toContain("ludens-core");
  } finally {
    await stopLocalAppDaemon(join(directory, "global"), { stopCores: true }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
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
    await writeFile(join(workspace, "ludens.json"), JSON.stringify({ driver: "cua", model: "openai-codex/gpt-6.2-sol" }, null, 2));
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
    await writeFile(join(wsDir, "ludens.json"), JSON.stringify({ driver: "cua", model: "openai-codex/gpt-6.2-sol" }, null, 2));
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
    join("/repo", "desktop/bin/ludens-app"),
    "--workspace",
    "/ws",
    "--show-window",
  ]);
  expect(petLaunchCommand("/repo", "/ws", "linux")).toEqual([
    join("/repo", "desktop/bin/ludens-app"),
    "--workspace",
    "/ws",
    "--show-window",
  ]);
  expect(petLaunchCommand("C:\\repo", "C:\\ws", "win32")).toEqual([
    join("C:\\repo", "desktop/node_modules/electron/dist/electron.exe"),
    join("C:\\repo", "desktop/dist/electron/main.js"),
    "--workspace",
    "C:\\ws",
    "--show-window",
  ]);
});
