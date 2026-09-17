import {parseArgs} from "node:util"
import {join, resolve} from "node:path"
import {parseCallBuild, parseCallFixture} from "./runner/call-fixture"
import {parseTeamsDevices} from "./runner/teams-devices"

const {positionals, values} = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    "fixture": {type: "string"},
    "build-manifest": {type: "string"},
    "help": {type: "boolean"},
    "browser-rejoin": {type: "boolean", default: false},
    "browser-capture-devices": {type: "string"},
    "browser-audio-only": {type: "boolean", default: false},
  },
})
const mode = positionals[0] ?? "describe"
if (values.help || mode === "describe") {
  console.log(await Bun.file(join(import.meta.dir, "CONNECTED-CALL-REPLAY.md")).text())
} else {
  if (!["validate", "run"].includes(mode)) throw new Error("Use describe, validate or run")
  if (!values.fixture || !values["build-manifest"]) throw new Error("--fixture and --build-manifest are required")
  const fixture = parseCallFixture(await Bun.file(resolve(values.fixture)).json())
  const manifestPath = resolve(values["build-manifest"])
  parseCallBuild(await Bun.file(manifestPath).json())
  const capturePath = values["browser-capture-devices"] ? resolve(values["browser-capture-devices"]) : undefined
  if (capturePath) parseTeamsDevices(await Bun.file(capturePath).json())
  if (values["browser-audio-only"] && !capturePath) throw new Error("Audio-only requires explicit laptop devices")
  if (capturePath && values["browser-rejoin"] && !values["browser-audio-only"])
    throw new Error("Rejoin with capture requires audio-only mode")
  if (mode === "validate") {
    console.log(
      JSON.stringify(
        {status: "configuration-valid", hardwareInspected: false, liveActions: 0, fixture, buildManifest: manifestPath},
        null,
        2,
      ),
    )
  } else {
    const {runConnectedCall} = await import("./runner/call-connected")
    const result = await runConnectedCall(fixture, manifestPath, {
      browserRejoin: values["browser-rejoin"],
      browserCaptureDevices: capturePath,
      browserAudioOnly: values["browser-audio-only"],
    })
    console.log(JSON.stringify(result))
    if (result.status !== "passed") process.exitCode = 1
  }
}
