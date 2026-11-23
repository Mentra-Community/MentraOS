/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

import type {InstallMiniappOptions, InstallMiniappResult} from "../installMiniapp"

const installed: InstallMiniappResult = {status: "installed", packageName: "com.example.notes", version: "1.0.0"}
const installMiniapp = mock(async (_url: string, _options: InstallMiniappOptions) => installed)
mock.module("../installMiniapp", () => ({installMiniapp}))

const {installMiniappFromLink, MiniappLinkError} = await import("../installMiniappFromLink")

const realFetch = globalThis.fetch
const confirm = async () => true

function directoryAnswers(status: number, body?: unknown) {
  globalThis.fetch = (async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {status})) as unknown as typeof fetch
}

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error) {
    expect(error).toBeInstanceOf(MiniappLinkError)
    return (error as InstanceType<typeof MiniappLinkError>).code
  }
  throw new Error("expected the link to be refused")
}

describe("installMiniappFromLink", () => {
  beforeEach(() => {
    installMiniapp.mockClear()
    globalThis.fetch = (() => {
      throw new Error("no request expected")
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("installs the miniapp URL an open link names, with the host's own options", async () => {
    const result = await installMiniappFromLink(
      "https://apps.mentraglass.com/open?url=https%3A%2F%2Fnotes.example.com%2F",
      {source: "link", confirm},
    )
    expect(result).toBe(installed)
    expect(installMiniapp).toHaveBeenCalledTimes(1)
    expect(installMiniapp.mock.calls[0]).toEqual(["https://notes.example.com/", {source: "link", confirm}])
  })

  test("installs a miniapp URL given on its own", async () => {
    await installMiniappFromLink("notes.example.com", {source: "paste", confirm})
    expect(installMiniapp.mock.calls[0]).toEqual(["https://notes.example.com/", {source: "paste", confirm}])
  })

  test("reads a link on the host app's own scheme", async () => {
    await installMiniappFromLink("myapp://open?url=https%3A%2F%2Fnotes.example.com%2F", {
      source: "link",
      schemes: ["myapp"],
    })
    expect(installMiniapp.mock.calls[0]).toEqual(["https://notes.example.com/", {source: "link"}])
  })

  test("installs the URL the directory lists for a package link, and only that package", async () => {
    directoryAnswers(200, {packageName: "com.example.notes", url: "https://notes.example.com/"})
    await installMiniappFromLink("https://apps.mentraglass.com/package/com.example.notes", {
      source: "link",
      confirm,
      directoryUrl: "https://apps.mentraglass.com",
    })
    expect(installMiniapp.mock.calls[0]).toEqual([
      "https://notes.example.com/",
      {source: "link", confirm, expectedPackageName: "com.example.notes"},
    ])
  })

  test("refuses what is not a link to a miniapp", async () => {
    expect(await codeOf(installMiniappFromLink("https://apps.mentraglass.com/", {source: "link"}))).toBe("not_a_link")
    expect(await codeOf(installMiniappFromLink("myapp://open?url=x", {source: "link"}))).toBe("not_a_link")
    expect(installMiniapp).not.toHaveBeenCalled()
  })

  test("a package link needs a directory", async () => {
    const link = "https://apps.mentraglass.com/package/com.example.notes"
    expect(await codeOf(installMiniappFromLink(link, {source: "link"}))).toBe("no_directory")
    expect(installMiniapp).not.toHaveBeenCalled()
  })

  test("a package the directory doesn't list is unlisted", async () => {
    directoryAnswers(404)
    const link = "https://apps.mentraglass.com/package/com.example.notes"
    const options = {source: "link" as const, directoryUrl: "https://apps.mentraglass.com"}
    expect(await codeOf(installMiniappFromLink(link, options))).toBe("unlisted")
    expect(installMiniapp).not.toHaveBeenCalled()
  })

  test("a directory that can't answer is directory_unreachable", async () => {
    directoryAnswers(503)
    const link = "https://apps.mentraglass.com/package/com.example.notes"
    const options = {source: "link" as const, directoryUrl: "https://apps.mentraglass.com"}
    expect(await codeOf(installMiniappFromLink(link, options))).toBe("directory_unreachable")
    expect(installMiniapp).not.toHaveBeenCalled()
  })
})
