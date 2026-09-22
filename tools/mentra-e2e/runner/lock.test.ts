import {expect, test} from "bun:test"
import {mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {acquireLock} from "./report"

async function fixture(run: (folder: string, path: string) => Promise<void>) {
  const folder = await mkdtemp(join(tmpdir(), "mentra-lock-test-"))
  try {
    await run(folder, join(folder, "com.mentra.mentra.lock"))
  } finally {
    await rm(folder, {recursive: true, force: true})
  }
}

async function staleOwner(path: string) {
  const child = Bun.spawn([process.execPath, "--eval", ""], {stdout: "ignore", stderr: "ignore"})
  await child.exited
  expect(() => process.kill(child.pid, 0)).toThrow()
  await writeFile(path, JSON.stringify({pid: child.pid, token: "dead-owner"}))
}

test("concurrent stale recovery cannot replace a newly acquired live lock", async () => {
  await fixture(async (folder, path) => {
    await staleOwner(path)
    // Isolate the filesystem interception in a subprocess. Pause A after its
    // stale read, let B finish acquiring, then resume A's stale observation.
    // The old unguarded implementation deterministically grants both owners.
    const probe = `
      import {mock} from "bun:test";
      import * as fs from "node:fs/promises";
      const realRead = fs.readFile;
      const folder = process.argv[1];
      const path = folder + "/com.mentra.mentra.lock";
      const observed = Promise.withResolvers();
      const resume = Promise.withResolvers();
      let paused = false;
      mock.module("node:fs/promises", () => ({...fs, readFile: async (...args) => {
        const contents = await realRead(...args);
        if (args[0] === path && !paused) {
          paused = true;
          observed.resolve();
          await resume.promise;
        }
        return contents;
      }}));
      const {acquireLock} = await import(process.argv[2]);
      const releases = [];
      const attempt = () => acquireLock(folder).then(
        release => { releases.push(release); return "acquired"; },
        error => String(error),
      );
      const first = attempt();
      await observed.promise;
      const second = await attempt();
      resume.resolve();
      const results = [await first, second];
      const owner = JSON.parse(await realRead(path, "utf8"));
      for (const release of releases) await release();
      console.log(JSON.stringify({results, owner, pid: process.pid}));
    `
    const child = Bun.spawn([process.execPath, "--eval", probe, folder, new URL("./report.ts", import.meta.url).href], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 5000)
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({code, stderr}).toEqual({code: 0, stderr: ""})
      const result = JSON.parse(stdout)
      expect(result.results.filter((entry: string) => entry === "acquired")).toHaveLength(1)
      expect(result.owner.pid).toBe(result.pid)
      expect(result.owner.token).not.toBe("dead-owner")
      await expect(stat(path)).rejects.toHaveProperty("code", "ENOENT")
      await expect(stat(`${path}.reclaim`)).rejects.toHaveProperty("code", "ENOENT")
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  })
}, 10000)

test("live ownership rejects contenders and repeated release cannot delete a successor", async () => {
  await fixture(async (folder, path) => {
    const release = await acquireLock(folder)
    const owner = await readFile(path, "utf8")
    await expect(acquireLock(folder)).rejects.toThrow("Another harness run owns the app")
    expect(await readFile(path, "utf8")).toBe(owner)
    await Promise.all([release(), release()])
    const next = await acquireLock(folder)
    const successor = await readFile(path, "utf8")
    await release()
    expect(await readFile(path, "utf8")).toBe(successor)
    expect(successor).not.toBe(owner)
    await next()
  })
})

test("ambiguous owners and an existing reclamation guard fail closed", async () => {
  await fixture(async (folder, path) => {
    for (const contents of ["", "{}", '{"pid":0,"token":"invalid"}']) {
      await writeFile(path, contents)
      await expect(acquireLock(folder)).rejects.toThrow()
      expect(await readFile(path, "utf8")).toBe(contents)
      await expect(stat(`${path}.reclaim`)).rejects.toHaveProperty("code", "ENOENT")
    }
    await staleOwner(path)
    const stale = await readFile(path, "utf8")
    await mkdir(`${path}.reclaim`)
    await expect(acquireLock(folder)).rejects.toThrow("stop all runs before removing")
    expect(await readFile(path, "utf8")).toBe(stale)
    expect((await stat(`${path}.reclaim`)).isDirectory()).toBe(true)
  })
})
