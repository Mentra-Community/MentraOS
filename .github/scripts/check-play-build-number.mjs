#!/usr/bin/env node
import {appendFileSync, readFileSync} from "node:fs"
import {playReleaseStatus} from "./native-build-numbers.mjs"

const status = playReleaseStatus({
  versionCode: Number(process.env.EXPECTED_BUILD),
  existingCodes: JSON.parse(readFileSync(process.env.GOOGLE_PLAY_VERSION_CODES_OUTPUT, "utf8")),
  immutableArtifactsExist: process.env.IMMUTABLE_ARTIFACTS_EXIST === "true",
})
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `exists=${status === "exists"}\n`)
console.log(`Google Play build ${process.env.EXPECTED_BUILD}: ${status}`)
