import {expect, test} from "bun:test"
import {mkdtemp, mkdir, rm, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {startReportViewer} from "../view"

test("report viewer supports video ranges and exposes only report assets inside the run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mentra-viewer-"))
  let server: Awaited<ReturnType<typeof startReportViewer>> | undefined
  try {
    const run = join(directory, "run")
    await mkdir(join(run, "screenshots"), {recursive: true})
    await writeFile(join(run, "index.html"), "<video src='routine.mp4'></video>")
    await writeFile(join(run, "routine.mp4"), "0123456789")
    await writeFile(join(run, "phone-private.log"), "private log")
    await writeFile(join(directory, "outside.png"), "outside file")
    await symlink(join(directory, "outside.png"), join(run, "screenshots", "outside.png"))
    server = await startReportViewer(run)
    const url = `http://127.0.0.1:${server.port}`
    expect((await fetch(url)).status).toBe(200)
    const range = await fetch(url + "/routine.mp4", {headers: {Range: "bytes=2-5"}})
    expect(range.status).toBe(206)
    expect(range.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(await range.text()).toBe("2345")
    expect(await (await fetch(url + "/routine.mp4", {method: "HEAD"})).text()).toBe("")
    for (const path of ["phone-private.log", "meeting-url.txt", "screenshots/outside.png", "%2e%2e/outside.png"])
      expect((await fetch(url + "/" + path)).status).toBe(404)
    expect((await fetch(url, {method: "POST"})).status).toBe(405)
    expect((await fetch(url, {headers: {Host: "example.com"}})).status).toBe(403)
  } finally {
    await server?.stop(true)
    await rm(directory, {recursive: true, force: true})
  }
})
