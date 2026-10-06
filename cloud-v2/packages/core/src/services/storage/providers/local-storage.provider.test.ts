import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageProvider } from "./local-storage.provider";

test("an interrupted local replacement leaves the previously stored object intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-storage-interrupted-"));
  const provider = new LocalStorageProvider({ rootDir: root });
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await provider.putObject({ key: "artifact", body: Buffer.from("acknowledged bytes"), contentType: "text/plain" });
    // Isolated child pauses the real filesystem write after a partial write. Killing
    // that writer must not truncate the acknowledged destination or depend on finally.
    child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      import { mock } from "bun:test";
      import * as fs from "node:fs/promises";
      const write = fs.writeFile;
      mock.module("node:fs/promises", () => ({ ...fs, writeFile: async (path, bytes, options) => {
        await write(path, bytes.subarray(0, 3), options);
        process.stdout.write("partial-write\\n");
        await new Promise(() => setInterval(() => {}, 1000));
      } }));
      const { LocalStorageProvider } = await import(${JSON.stringify(new URL("./local-storage.provider.ts", import.meta.url).href)});
      await new LocalStorageProvider({ rootDir: ${JSON.stringify(root)} }).putObject({
        key: "artifact", body: Buffer.from("replacement bytes"), contentType: "text/plain"
      });
    `], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const ready = await Promise.race([child.stdout.getReader().read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("partial write did not start")), 3000);
    })]);
    clearTimeout(timer);
    expect(new TextDecoder().decode(ready.value)).toBe("partial-write\n");
    expect(await readFile(join(root, "artifact"), "utf8")).toBe("acknowledged bytes");
    child.kill();
    await child.exited;
    expect(await readFile(join(root, "artifact"), "utf8")).toBe("acknowledged bytes");
    expect((await readdir(root)).some(name => name.endsWith(".tmp"))).toBe(true);
    await provider.putObject({ key: "artifact", body: Buffer.from("complete replacement"), contentType: "text/plain" });
    expect(await readFile(join(root, "artifact"), "utf8")).toBe("complete replacement");
  } finally {
    clearTimeout(timer);
    child?.kill();
    await child?.exited;
    await rm(root, { recursive: true, force: true });
  }
});
