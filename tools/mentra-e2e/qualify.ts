import {resolve} from "node:path"
import {credentials} from "./runner/credentials"
import {root} from "./runner/driver"

// One hidden credential prompt, then three independent, unattended run folders.
const account = await credentials()
for (let index = 1; index <= 3; index++) {
  console.log(`Qualification run ${index}/3`)
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      resolve(root, "tools/mentra-e2e/run.ts"),
      "run",
      "--suite",
      "no-glasses",
      ...process.argv.slice(2),
    ],
    {
      cwd: root,
      env: {...process.env, MENTRA_E2E_EMAIL: account.email, MENTRA_E2E_PASSWORD: account.password},
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  const code = await child.exited
  if (code !== 0) process.exit(code)
}
console.log("All three complete no-glasses replays passed.")
