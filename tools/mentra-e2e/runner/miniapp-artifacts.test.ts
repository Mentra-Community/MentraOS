import {expect, test} from "bun:test"
import {createHash} from "node:crypto"
import {mkdtemp, mkdir, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {bundledMiniappArtifacts} from "./miniapp-artifacts"

test("record the running bundle's archive bytes, including a same-version replacement", async () => {
  const bundle = await mkdtemp(join(tmpdir(), "mentra-e2e-miniapp-"))
  try {
    expect(await bundledMiniappArtifacts(bundle)).toMatchObject({status: "unavailable"})
    const directory = join(bundle, "assets/assets/miniapps")
    await mkdir(directory, {recursive: true})
    await writeFile(join(directory, "com.mentra.call-2.1.13.zip"), "first archive bytes")
    await writeFile(join(directory, "icon.png"), "not an archive")
    const first = await bundledMiniappArtifacts(bundle)
    expect(first).toEqual({
      status: "recorded",
      archives: [
        {
          path: "assets/assets/miniapps/com.mentra.call-2.1.13.zip",
          sha256: createHash("sha256").update("first archive bytes").digest("hex"),
        },
      ],
    })
    await writeFile(join(directory, "com.mentra.call-2.1.13.zip"), "different archive bytes")
    expect(await bundledMiniappArtifacts(bundle)).not.toEqual(first)
  } finally {
    await rm(bundle, {recursive: true, force: true})
  }
})
