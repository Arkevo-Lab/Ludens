import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Bridge } from "../src/drivers/bridge.ts";
import { createCuaProvider, cuaCapabilities } from "../src/drivers/cua/provider.ts";

const clock = { id: "machines-test", now: () => performance.now() };
type CuaClient = Parameters<typeof cuaCapabilities>[0]["client"];
const tool = (name: string): Tool => ({
  name, description: `Fixture ${name}`, inputSchema: { type: "object", properties: { session: { type: "string" } } },
});

/** Minimal stdio MCP server source listing one tool; records its own argv when argvFile is set. */
function fixtureServerSource(argvFile?: string) {
  const resolve = (specifier: string) => JSON.stringify(Bun.resolveSync(specifier, import.meta.dir));
  return `import { Server } from ${resolve("@modelcontextprotocol/sdk/server/index.js")};
import { StdioServerTransport } from ${resolve("@modelcontextprotocol/sdk/server/stdio.js")};
import { ListToolsRequestSchema } from ${resolve("@modelcontextprotocol/sdk/types.js")};
${argvFile ? `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv));\n` : ""}const server = new Server({ name: "fixture-cua", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
  { name: "echo_state", description: "fixture", inputSchema: { type: "object", properties: {} } }] }));
await server.connect(new StdioServerTransport());
`;
}

test("Bridge.open reaches an explicitly given host", async () => {
  const seen: string[][] = [];
  const server = createServer(socket => {
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      for (const line of String(chunk).split("\n")) {
        if (!line) continue;
        const [id, op, ...args] = line.split("\t");
        seen.push([op, ...args]);
        socket.write(`${id}\tOK\t${op}-ack\n`);
      }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("listening", listening.resolve);
  server.listen(0, "127.0.0.1");
  await listening.promise;
  const { port } = server.address() as { port: number };
  try {
    const bridge = await Bridge.open(port, "127.0.0.1");
    try {
      expect(await bridge.request("HELLO", ["machine", 1])).toEqual(["HELLO-ack"]);
      expect(seen).toEqual([["HELLO", "machine", "1"]]);
    } finally { bridge.close(); }
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  }
});

test("createCuaProvider spawns stdio with custom args and speaks MCP end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "baseware-cua-stdio-"));
  const argvFile = join(root, "argv.json");
  const serverFile = join(root, "server.ts");
  await writeFile(serverFile, fixtureServerSource(argvFile));
  try {
    const provider = await createCuaProvider({ command: process.execPath, args: [serverFile], clock });
    try {
      expect(provider.version).toBe("0.0.0");
      expect(provider.capabilities.controllers.map(controller => controller.tool.name)).toEqual(["echo_state"]);
      // Custom args reach the child untouched; the default would have been ["mcp"].
      expect(JSON.parse(await readFile(argvFile, "utf8"))).toEqual([process.execPath, realpathSync(serverFile)]);
    } finally { await provider.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ssh transport mode builds the documented ssh argv and runs the remote command over it", async () => {
  const root = await mkdtemp(join(tmpdir(), "baseware-cua-ssh-"));
  const sshArgsFile = join(root, "ssh-argv.txt");
  const serverFile = join(root, "server.ts");
  await writeFile(serverFile, fixtureServerSource());
  // A fake ssh on PATH: record argv, then serve MCP stdio in its place.
  const sshFile = join(root, "ssh");
  await writeFile(sshFile, `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(sshArgsFile)}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverFile)}
`);
  await chmod(sshFile, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${root}:${path}`;
  try {
    const configured = await createCuaProvider({ transportMode: "ssh",
      ssh: { host: "box.local", user: "dev", port: 2222, identityFile: "/keys/id_ed25519", command: "cua-remote mcp" }, clock });
    try {
      expect(configured.capabilities.controllers.map(controller => controller.tool.name)).toEqual(["echo_state"]);
    } finally { await configured.close(); }
    expect((await readFile(sshArgsFile, "utf8")).trim().split("\n")).toEqual(
      ["-o", "BatchMode=yes", "-p", "2222", "-i", "/keys/id_ed25519", "dev@box.local", "cua-remote mcp"]);

    // ssh config alone selects ssh mode; defaults: no user/port/identity, remote command cua-driver mcp.
    const inferred = await createCuaProvider({ ssh: { host: "bare" }, clock });
    try {
      expect(inferred.capabilities.controllers.map(controller => controller.tool.name)).toEqual(["echo_state"]);
    } finally { await inferred.close(); }
    expect((await readFile(sshArgsFile, "utf8")).trim().split("\n")).toEqual(
      ["-o", "BatchMode=yes", "bare", "cua-driver mcp"]);
  } finally {
    process.env.PATH = path;
    await rm(root, { recursive: true, force: true });
  }
});

test("remote machines drop a missing remote screenshot path when inline media already carries the frame", async () => {
  const result: CallToolResult = {
    content: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
    structuredContent: { screenshot_file_path: "/remote/var/lib/cua/latest.png" },
  };
  const client = { async callTool(args: { name: string }) {
    return args.name === "start_session" ? { content: [] } : result;
  } } as CuaClient;
  const context = { signal: new AbortController().signal };

  const remote = cuaCapabilities({ tools: [tool("get_desktop_state")], client, clock }, true);
  const remoteExecution = await remote.controllers[0]!.execute({}, context);
  expect(remoteExecution.observations).toHaveLength(1);
  expect(remoteExecution.observations![0]!.contentIndex).toBe(0);
  expect(remoteExecution.observations![0]!.path).toBeUndefined();

  // Local machines keep the caller-owned path observation even before any local copy exists.
  const local = cuaCapabilities({ tools: [tool("get_desktop_state")], client, clock });
  const localExecution = await local.controllers[0]!.execute({}, context);
  expect(localExecution.observations).toHaveLength(2);
  expect(localExecution.observations!.at(-1)!.path).toBe("/remote/var/lib/cua/latest.png");
});
