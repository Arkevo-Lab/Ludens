import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStaleLocalSocket } from "../src/local-socket.ts";

test("local socket cleanup preserves a regular file and a live listener, then permits restarting a dead listener", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-sock-"));
  const socket = join(directory, "service.sock");
  const inUse = () => new Error("listener is active");
  let server: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await clearStaleLocalSocket(socket, inUse);
    await writeFile(socket, "keep this file");
    await expect(clearStaleLocalSocket(socket, inUse)).rejects.toThrow("Not a Unix socket");
    expect(await readFile(socket, "utf8")).toBe("keep this file");
    await rm(socket);

    const source = 'require("node:net").createServer().listen(process.argv[1], () => console.log("ready"));';
    server = Bun.spawn([process.execPath, "-e", source, socket], { stdout: "pipe", stderr: "inherit" });
    const ready = server.stdout.getReader();
    try { expect(new TextDecoder().decode((await ready.read()).value).trim()).toBe("ready"); }
    finally { ready.releaseLock(); }
    await expect(clearStaleLocalSocket(socket, inUse)).rejects.toThrow("listener is active");

    server.kill("SIGKILL");
    await server.exited;
    await clearStaleLocalSocket(socket, inUse);
    server = Bun.spawn([process.execPath, "-e", source, socket], { stdout: "pipe", stderr: "inherit" });
    const restarted = server.stdout.getReader();
    try { expect(new TextDecoder().decode((await restarted.read()).value).trim()).toBe("ready"); }
    finally { restarted.releaseLock(); }
  } finally {
    if (server) {
      if (server.exitCode === null) server.kill("SIGKILL");
      await server.exited;
    }
    await clearStaleLocalSocket(socket, inUse).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
