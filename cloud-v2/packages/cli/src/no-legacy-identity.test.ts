import {expect, test} from "bun:test"
import {readdirSync, readFileSync, statSync} from "node:fs"
import {join, relative} from "node:path"

const PACKAGE = new URL("..", import.meta.url).pathname
// Spelled in pieces so this file does not match itself.
const RETIRED_PROVIDER = new RegExp(["work", "os"].join(""), "i")

function files(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    if (entry === "node_modules" || entry === "dist") return []
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

test("the CLI package has no trace of the retired sign-in provider", () => {
  const matches = files(PACKAGE).flatMap(path =>
    readFileSync(path, "utf8")
      .split("\n")
      .map((line, index) => ({line, at: `${relative(PACKAGE, path)}:${index + 1}`}))
      .filter(({line}) => RETIRED_PROVIDER.test(line))
      .map(({at}) => at),
  )
  expect(matches).toEqual([])
})
