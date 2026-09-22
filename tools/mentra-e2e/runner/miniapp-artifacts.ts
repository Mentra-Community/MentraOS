import {createHash} from "node:crypto"
import {readFile, readdir} from "node:fs/promises"
import {join} from "node:path"

/** Archives in the running binary, not a claim about the runtime's extracted/updated miniapps. */
export async function bundledMiniappArtifacts(bundlePath: string) {
  const directory = "assets/assets/miniapps"
  let files: string[]
  try {
    files = await readdir(join(bundlePath, directory))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {status: "unavailable" as const, reason: "This binary has no loose bundled-miniapp archive directory"}
    throw error
  }
  const archives = await Promise.all(
    files
      .filter((name) => name.endsWith(".zip"))
      .sort()
      .map(async (name) => ({
        path: `${directory}/${name}`,
        sha256: createHash("sha256")
          .update(await readFile(join(bundlePath, directory, name)))
          .digest("hex"),
      })),
  )
  return {status: "recorded" as const, archives}
}
