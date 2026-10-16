import type {FrameworkBinding, RoutineSourceRef} from "../types/framework-version.types"

/** Independent software fixture identities; they imply no published artifact or device qualification. */
export function testRoutineSource(commit = "a".repeat(40)): RoutineSourceRef {
  return {
    repository: "Mentra-Community/Mentra-Automated-Testing",
    commit,
    bundle: {url: "https://source.example/routine-fixture.tar.gz", sha256: "e".repeat(64), size: 123},
    minimumRoutineApiVersion: 1,
  }
}
export function testFrameworkBinding(): FrameworkBinding {
  return {
    version: 40,
    revision: "f".repeat(40),
    installationId: "software-framework-fixture",
    configurationSha256: "b".repeat(64),
    runtimeSha256: "c".repeat(64),
    routineApiVersion: 1,
    publicApiSha256: "d".repeat(64),
  }
}
