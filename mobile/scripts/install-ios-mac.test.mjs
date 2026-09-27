import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {execFile} from "node:child_process"
import {afterEach, test} from "node:test"
import {mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {promisify} from "node:util"
import {acquireAppOwnership} from "./app-ownership.mjs"
import {
  claimInstallation,
  commitStagedInstallation,
  InstallationRollbackError,
  installBuild,
  isPortableMacPackage,
  parseInstallerArgs,
  verifyLauncherOverride,
} from "./install-ios-mac.mjs"

const roots = []
const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mentra-installer-test-"))
  roots.push(root)
  return path.join(root, "Applications", "Mentra E2E")
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true})
})

test(
  "an active worker blocks installation before the managed app is touched",
  {skip: process.platform !== "darwin"},
  async () => {
    const root = await fixture()
    const home = path.dirname(path.dirname(root))
    const release = await acquireAppOwnership(path.join(home, ".cache/mentra-e2e"))
    const manifest = path.join(home, "build.json")
    await writeFile(
      manifest,
      JSON.stringify({app: "Mentra.app", bundleId: "com.mentra.mentra", executableSha256: "a".repeat(64)}),
    )
    const program = `
    import assert from "node:assert/strict";
    const {installBuild} = await import(process.argv[1]);
    await assert.rejects(installBuild(process.argv[2]), /Mentra is owned/);
  `
    try {
      await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "--eval", program, new URL("./install-ios-mac.mjs", import.meta.url).href, manifest],
        {env: {...process.env, HOME: home}, timeout: 10000},
      )
      await assert.rejects(readFile(path.join(root, "owner.json")), {code: "ENOENT"})
      assert.equal(
        JSON.parse(await readFile(path.join(home, ".cache/mentra-e2e/com.mentra.mentra.lock"))).pid,
        process.pid,
      )
    } finally {
      await release()
    }
  },
)

// Isolate HOME and replace every installer subprocess before importing it. Only temporary fixture files change; no
// signing, installer or launcher runs. An Android run's retained glasses lease is written by the shared module.
async function glassesAdmissionCase(mode) {
  const root = await fixture()
  const home = await realpath(path.dirname(path.dirname(root)))
  const program = String.raw`
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import {syncBuiltinESMExports} from "node:module";
    import {createHash} from "node:crypto";
    import {cpSync, writeFileSync} from "node:fs";
    import fsp, {access, mkdir, readFile, readlink, symlink, writeFile} from "node:fs/promises";
    import path from "node:path";
    const [installerURL, ownershipURL, mode] = process.argv.slice(1);
    Object.defineProperty(process, "platform", {value: "darwin"});
    const home = process.env.HOME;
    const root = path.join(home, "Applications/Mentra E2E");
    const folder = path.join(home, ".cache/mentra-e2e");
    const calls = [];
    const launcherPath = path.join(home, "pinned-launcher");
    const appLock = path.join(folder, "com.mentra.mentra.lock");
    // Stands in for the launched Mentra: a real temporary process that outlives the launcher, as the app does. It is
    // detached (reparented, so it is reaped on exit) so that a normal quit really ends it.
    const realExecFileSync = childProcess.execFileSync;
    const shell = (script) => realExecFileSync("/bin/sh", ["-c", script], {encoding: "utf8"}).trim();
    const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } };
    const quit = (pid) => shell("kill " + pid + "; while kill -0 " + pid + " 2>/dev/null; do sleep 0.05; done");
    let launched;
    process.on("exit", () => { if (launched && alive(launched)) process.kill(launched) }); // never outlives this test
    childProcess.execFileSync = (name, args) => {
      calls.push({name, args});
      if (name === launcherPath && args[0] === "--quit" && launched && alive(launched)) {
        quit(launched); // the launcher's normal termination of the running app
        return "Stopped com.mentra.mentra through normal application termination.";
      }
      if (name === launcherPath && args[0] !== "--quit" && mode !== "launch-no-pid") {
        launched = Number(shell("/bin/sleep 60 >/dev/null 2>&1 & echo $!"));
        // The launcher may fail after asking macOS to open Mentra (e.g. its timeout on a pending permission prompt).
        if (mode === "launch-timeout")
          throw new Error("Launch did not finish within 30 seconds. Inspect macOS setup permissions.");
        return "Launched com.mentra.mentra pid=" + launched + " without requesting foreground activation.";
      }
      if (name === "/usr/bin/codesign" && mode === "launch-prelaunch-failure")
        throw new Error("fake invalid Apple signature");
      if (name === "/usr/bin/codesign" && mode === "launch-adopt-failure" && launched)
        throw new Error("fake invalid Apple signature");
      if (name === "/usr/libexec/PlistBuddy") return args[1].includes("CFBundleIdentifier") ? "com.mentra.mentra" : "Mentra";
      if (name === "/usr/bin/codesign") return "verified fixture signature";
      if (name === "/usr/bin/security") return "fixture provisioning profile";
      if (name === "/usr/bin/plutil") return args[1] === "ExpirationDate" ? "2999-01-01T00:00:00Z" : '["fixture-mac"]';
      if (name === "/usr/sbin/system_profiler") return JSON.stringify({SPHardwareDataType: [{provisioning_UDID: "fixture-mac"}]});
      if (name === "/bin/cp") {
        cpSync(args[1], args[2], {recursive: true});
        return "";
      }
      if (name === "/usr/bin/ditto" && args[0] === "-c") {
        writeFileSync(args.at(-1), "fixture backup of the previous installation");
        return "";
      }
      if (name === "/usr/bin/unzip") return "";
      if (name === launcherPath) return "fixture launcher";
      throw new Error("Unexpected real command: " + name);
    };
    // Cleanup of the installation's transaction lock fails after a successful launch.
    if (mode === "launch-cleanup-failure") {
      const {rm} = fsp;
      fsp.rm = async (file, options) => {
        if (String(file).endsWith("/.install-lock")) throw new Error("fake cleanup failure");
        return rm(file, options);
      };
    }
    syncBuiltinESMExports();
    const {installBuild} = await import(installerURL);
    const {acquireAppOwnership, readLockState} = await import(ownershipURL);
    const app = path.join(home, "download/Mentra.app");
    await mkdir(app, {recursive: true});
    await writeFile(path.join(app, "Mentra"), "fixture executable");
    await writeFile(path.join(app, "Info.plist"), "fixture plist");
    await writeFile(launcherPath, "fixture pinned launcher");
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    const manifestPath = path.join(home, "download/build.json");
    await writeFile(manifestPath, JSON.stringify({app: "Mentra.app", bundleId: "com.mentra.mentra",
      executableSha256: digest("fixture executable"), macPackageVersion: 2, macInstaller: "Install Mentra.app"}));
    const launch = mode.startsWith("launch");
    const options = {launcherPath, launcherSha256: digest("fixture pinned launcher"), launch};
    const glassesLease = path.join(folder, "glasses/unit-060b/com.mentra.mentra.lock");
    if (mode.endsWith("-held"))
      await acquireAppOwnership(path.dirname(glassesLease), {reservation: {runID: "android-060b",
        runDirectory: path.join(home, "android-run"), fixtureID: "android-060b"}});
    const heldLease = mode.endsWith("-held") ? await readFile(glassesLease, "utf8") : undefined;
    // A lease entry that is a dangling symlink exists; only a missing entry is an absent lease.
    const danglingTarget = path.join(home, "missing-lease-target");
    if (mode.endsWith("-dangling")) {
      await mkdir(path.dirname(glassesLease), {recursive: true});
      await symlink(danglingTarget, glassesLease);
    }
    if (mode === "launch-held" || mode === "launch-dangling") {
      await assert.rejects(installBuild(manifestPath, options), /Physical glasses are held/);
      assert.equal(calls.length, 0); // nothing quit, verified, replaced or launched
      await assert.rejects(access(path.join(root, "Mentra.app")), {code: "ENOENT"});
    } else if (mode === "launch-timeout") {
      // The launch was attempted and its outcome is unknown: the broad installer lease stays held, nothing is retried.
      const error = await installBuild(manifestPath, options).then(() => assert.fail("launch failure was hidden"), (error) => error);
      assert.equal(alive(launched), true); // the app may well have opened; it is not assumed away
      const kept = JSON.parse(await readFile(appLock, "utf8")); // the lease was not released
      assert.deepEqual([kept.pid, kept.retainOnExit, kept.launchedApp, kept.reservation], [process.pid, true, undefined, undefined]);
      assert.match(error.message, /whether Mentra opened is unknown/);
      assert.match(error.cause.message, /Launch did not finish within 30 seconds/);
      assert.deepEqual(await readLockState(folder), {state: "held", pid: process.pid});
      await assert.rejects(acquireAppOwnership(folder, {reservation: {runID: "mac-03be", runDirectory: path.join(home, "run"),
        fixtureID: "mac-03be"}}), /Mentra is owned by a test or installation/);
      assert.equal(JSON.parse(await readFile(appLock, "utf8")).token, kept.token);
      assert.deepEqual(calls.filter((call) => call.name === launcherPath && call.args[0] !== "--quit").length, 1);
      process.exit(0);
    } else if (mode === "launch-cleanup-failure") {
      // The app was launched once, but installation cleanup failed: the installer keeps its retained lease, which
      // was not handed to the app, so it stays held even after that app exits.
      await assert.rejects(installBuild(manifestPath, options), /Installation cleanup failed/);
      assert.equal(calls.filter((call) => call.name === launcherPath && call.args[0] !== "--quit").length, 1);
      const kept = await readFile(appLock, "utf8");
      quit(launched); // the app exits; a different process then tries to take the app lock
      const other = shell(JSON.stringify(process.execPath) + " --input-type=module --eval " + JSON.stringify(
        "const {acquireAppOwnership} = await import(process.argv[1]); " +
        "await acquireAppOwnership(process.argv[2]).then(() => console.log('ACQUIRED'), (error) => console.log('REFUSED ' + error.message));") +
        " " + JSON.stringify(ownershipURL) + " " + JSON.stringify(folder));
      assert.match(other, /^REFUSED Mentra is owned by a test or installation/);
      assert.equal(await readFile(appLock, "utf8"), kept);
      const owner = JSON.parse(kept);
      assert.deepEqual([owner.pid, owner.retainOnExit, owner.launchedApp, owner.reservation], [process.pid, true, undefined, undefined]);
      process.exit(0);
    } else if (mode === "launch-prelaunch-failure") {
      // A failure before any launch attempt keeps its normal release.
      await assert.rejects(installBuild(manifestPath, options), /fake invalid Apple signature/);
      assert.equal(calls.some((call) => call.name === launcherPath), false);
    } else if (mode === "launch-no-pid") {
      // Mentra was launched but the launcher did not identify its process: the installer keeps its retained lease.
      await assert.rejects(installBuild(manifestPath, options), /launched Mentra process/);
      const kept = JSON.parse(await readFile(appLock, "utf8"));
      assert.equal(kept.pid, process.pid);
      assert.equal(kept.retainOnExit, true);
      assert.equal(kept.launchedApp, undefined);
      process.exit(0);
    } else {
      await installBuild(manifestPath, options);
      assert.deepEqual(calls.filter((call) => call.name === launcherPath).map((call) => call.args[0]),
        launch ? ["--quit", path.join(root, "Mentra.app")] : ["--quit"]);
      assert.equal(await readFile(path.join(root, "Mentra.app/Wrapper/Mentra.app/Mentra"), "utf8"), "fixture executable");
    }
    if (launched) {
      // After the launcher returned, the app lock belongs to the launched app's own process: held while it runs.
      const opened = await readFile(appLock, "utf8");
      const owner = JSON.parse(opened);
      assert.deepEqual([owner.pid, owner.launchedApp, owner.retainOnExit, owner.reservation], [launched, true, undefined, undefined]);
      assert.deepEqual(await readLockState(folder), {state: "held", pid: launched});
      // A test owner, which may narrow to one pair of glasses, is refused while the app runs.
      await assert.rejects(acquireAppOwnership(folder, {reservation: {runID: "mac-03be", runDirectory: path.join(home, "run"),
        fixtureID: "mac-03be"}}), /quit Mentra normally/);
      assert.equal(await readFile(appLock, "utf8"), opened);
      if (mode === "launch-takeover") {
        // A later file-only installation adopts the running app under broad custody, quits it normally, then releases.
        calls.length = 0;
        await installBuild(manifestPath, {...options, launch: false});
        assert.deepEqual(calls.filter((call) => call.name === launcherPath).map((call) => call.args[0]), ["--quit"]);
        assert.equal(alive(launched), false);
      } else if (mode === "launch-adopt-failure") {
        // An installation that adopts the running app but fails before quitting it hands the lock back to that app.
        await assert.rejects(installBuild(manifestPath, {...options, launch: false}), /fake invalid Apple signature/);
        assert.equal(alive(launched), true);
        assert.deepEqual(await readLockState(folder), {state: "held", pid: launched});
        assert.equal(JSON.parse(await readFile(appLock, "utf8")).launchedApp, true);
        quit(launched);
        assert.deepEqual(await readLockState(folder), {state: "reclaimable"});
        await (await acquireAppOwnership(folder))();
      } else {
        // Normal release: once the app's own process has exited, the lock is reclaimable by the next owner.
        quit(launched);
        assert.deepEqual(await readLockState(folder), {state: "reclaimable"});
        await (await acquireAppOwnership(folder))();
      }
    }
    await assert.rejects(access(appLock), {code: "ENOENT"});
    if (heldLease) assert.equal(await readFile(glassesLease, "utf8"), heldLease);
    if (mode.endsWith("-dangling")) assert.equal(await readlink(glassesLease), danglingTarget);
  `
  await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "--eval", program,
      new URL("./install-ios-mac.mjs", import.meta.url).href,
      new URL("./app-ownership.mjs", import.meta.url).href, mode],
    {env: {...process.env, HOME: home}, timeout: 10000},
  )
}

test("a launching installation refuses while a physical glasses lease is held, before touching the app", async () => {
  await glassesAdmissionCase("launch-held")
})

test("a file-only installation needs no glasses and proceeds beside a held glasses lease", async () => {
  await glassesAdmissionCase("no-launch-held")
})

test("a launched app owns the app lock after the launcher returns, until its own process exits", async () => {
  await glassesAdmissionCase("launch")
})

test("a later installation takes over a running launched app's lock", async () => {
  await glassesAdmissionCase("launch-takeover")
})

test("an unidentified launched process leaves the installer's lease retained for recovery", async () => {
  await glassesAdmissionCase("launch-no-pid")
})

test("an installation that adopts a running app but fails before quitting it hands the lock back to that app", async () => {
  await glassesAdmissionCase("launch-adopt-failure")
})

test("a launcher failure after the launch was attempted keeps the installer's lease; nothing is launched again", async () => {
  await glassesAdmissionCase("launch-timeout")
})

test("a failure before any launch attempt still releases the installer's lease", async () => {
  await glassesAdmissionCase("launch-prelaunch-failure")
})

test("a cleanup failure after a successful launch keeps the installer's retained lease, not the app's", async () => {
  await glassesAdmissionCase("launch-cleanup-failure")
})

test("a dangling symlink as a glasses lease is held: launching refuses, a file-only install proceeds", async () => {
  await glassesAdmissionCase("launch-dangling")
  await glassesAdmissionCase("no-launch-dangling")
})

// A concurrent physical-glasses owner reads the app lock (readLockState, as Android admission does) at every step of an
// installer's takeover of a running app's lease. Only temporary folders and one temporary stand-in process are used.
async function takeoverInterleavingCase(mode) {
  const root = await fixture()
  const folder = path.join(path.dirname(path.dirname(root)), ".cache/mentra-e2e")
  const program = String.raw`
    import assert from "node:assert/strict";
    import {execFileSync} from "node:child_process";
    import fsp from "node:fs/promises";
    import {syncBuiltinESMExports} from "node:module";
    import path from "node:path";
    const [ownershipURL, folder, mode] = process.argv.slice(1);
    const lockPath = path.join(folder, "com.mentra.mentra.lock");
    // The running app: a detached stand-in process (reaped on exit), always killed when this test ends.
    const app = Number(execFileSync("/bin/sh", ["-c", "/bin/sleep 60 >/dev/null 2>&1 & echo $!"], {encoding: "utf8"}).trim());
    process.on("exit", () => { try { process.kill(app) } catch {} });
    await fsp.mkdir(folder, {recursive: true});
    const appRecord = JSON.stringify({pid: app, token: "app-token", launchedApp: true});
    await fsp.writeFile(lockPath, appRecord, {mode: 0o600});
    let readLockState;
    const observed = [];
    const observe = async (step) => {
      let state;
      try { state = await readLockState(folder) } catch { state = {state: "unverifiable"} }
      observed.push({step, ...state});
    };
    const {open, rename, unlink} = fsp;
    fsp.open = async (file, flags, ...rest) => {
      if (String(file).startsWith(lockPath) && flags === "wx") {
        await observe("before creating " + path.basename(String(file)));
        if (mode === "write-failure") throw Object.assign(new Error("fake disk full"), {code: "ENOSPC"});
      }
      return open(file, flags, ...rest);
    };
    fsp.rename = async (from, to) => {
      if (to === lockPath) await observe("before replacing");
      await rename(from, to);
      if (to === lockPath) await observe("after replacing");
    };
    fsp.unlink = async (file) => {
      await unlink(file);
      if (file === lockPath) await observe("after unlinking");
    };
    syncBuiltinESMExports();
    const ownership = await import(ownershipURL);
    readLockState = ownership.readLockState;
    if (mode === "write-failure") {
      // The installer's replacement cannot be written: the running app keeps its exact lease, nothing is left behind.
      await assert.rejects(ownership.acquireAppOwnership(folder, {installer: true}), /fake disk full/);
      assert.equal(await fsp.readFile(lockPath, "utf8"), appRecord);
      assert.deepEqual(await fsp.readdir(folder), ["com.mentra.mentra.lock"]);
    } else {
      const release = await ownership.acquireAppOwnership(folder, {installer: true});
      const taken = JSON.parse(await fsp.readFile(lockPath, "utf8"));
      assert.deepEqual([taken.pid, taken.retainOnExit, taken.reservation], [process.pid, true, undefined]);
      assert.deepEqual(await fsp.readdir(folder), ["com.mentra.mentra.lock"]);
      await release(); // the app was not quit, so it gets its lease back
      assert.deepEqual(await readLockState(folder), {state: "held", pid: app});
    }
    // At no step could a physical-glasses owner see the app lock absent or free while the app ran.
    assert.ok(observed.length > 0, "no takeover step was observed");
    for (const seen of observed) assert.equal(seen.state, "held", JSON.stringify(observed));
  `
  await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "--eval", program, new URL("./app-ownership.mjs", import.meta.url).href, folder, mode],
    {timeout: 10000},
  )
}

test("an installer takes over a running app's lease without ever exposing it as absent", async () => {
  await takeoverInterleavingCase("takeover")
})

test("an installer that cannot write its replacement leaves the running app's lease untouched", async () => {
  await takeoverInterleavingCase("write-failure")
})

async function launcherFixture() {
  const root = await fixture()
  await mkdir(root, {recursive: true})
  const file = path.join(root, "launcher")
  const contents = "verified launcher fixture; never executed"
  await writeFile(file, contents)
  return {file: await realpath(file), sha256: createHash("sha256").update(contents).digest("hex")}
}

test("preinstalled launcher must match its independently supplied pin", async () => {
  const {file, sha256} = await launcherFixture()
  assert.deepEqual(await verifyLauncherOverride(file, sha256), {source: "preinstalled", path: file, sha256})
  assert.equal(await verifyLauncherOverride(), undefined)
  await assert.rejects(verifyLauncherOverride(file, "0".repeat(64)), /SHA256 mismatch/)
  await writeFile(file, "replaced launcher")
  await assert.rejects(verifyLauncherOverride(file, sha256), /SHA256 mismatch/)
})

test("missing or non-file preinstalled launchers are rejected", async () => {
  const {file, sha256} = await launcherFixture()
  await assert.rejects(verifyLauncherOverride(`${file}-missing`, sha256), {code: "ENOENT"})
  await assert.rejects(verifyLauncherOverride(path.dirname(file), sha256), /regular file/)
})

test("preinstalled launcher rejects a symlink or a symlinked parent", async () => {
  const {file, sha256} = await launcherFixture()
  const alias = `${file}-alias`
  await symlink(file, alias)
  await assert.rejects(verifyLauncherOverride(alias, sha256), /without symlinks/)
  const parentAlias = path.join(path.dirname(path.dirname(file)), "alias")
  await symlink(path.dirname(file), parentAlias)
  await assert.rejects(verifyLauncherOverride(path.join(parentAlias, "launcher"), sha256), /without symlinks/)
})

test("preinstalled launcher requires a canonical absolute path and a complete SHA256 pin", async () => {
  const {file, sha256} = await launcherFixture()
  await assert.rejects(verifyLauncherOverride("relative/launcher", sha256), /absolute canonical path/)
  await assert.rejects(verifyLauncherOverride(`${path.dirname(file)}/./launcher`, sha256), /absolute canonical path/)
  await assert.rejects(verifyLauncherOverride(file, "short-pin"), /Invalid.*SHA256/)
  await assert.rejects(verifyLauncherOverride(file), /together/)
  await assert.rejects(verifyLauncherOverride(undefined, sha256), /together/)
})

test("installer CLI preserves existing defaults and accepts the pinned launcher pair", () => {
  assert.deepEqual(parseInstallerArgs(["--manifest", "build.json"]), {
    manifestPath: path.resolve("build.json"),
    launch: true,
    launcherPath: undefined,
    launcherSha256: undefined,
  })
  assert.deepEqual(
    parseInstallerArgs([
      "--manifest",
      "build.json",
      "--launcher",
      "/host/launcher",
      "--launcher-sha256",
      "a".repeat(64),
      "--no-launch",
    ]),
    {
      manifestPath: path.resolve("build.json"),
      launch: false,
      launcherPath: "/host/launcher",
      launcherSha256: "a".repeat(64),
    },
  )
})

test("installer CLI rejects incomplete launcher selection and malformed arguments", () => {
  assert.throws(() => parseInstallerArgs(["--manifest", "build.json", "--launcher", "/host/launcher"]), /together/)
  assert.throws(() => parseInstallerArgs(["--manifest", "build.json", "--launcher-sha256", "a".repeat(64)]), /together/)
  assert.throws(() => parseInstallerArgs(["--manifest", "build.json", "--launcher"]))
  assert.throws(() => parseInstallerArgs(["--manifest", "build.json", "--unknown"]))
  assert.throws(() => parseInstallerArgs([]), /Usage:/)
})

test("both CI package formats use portable provisioning checks without requiring Xcode", () => {
  assert.equal(isPortableMacPackage({app: "Mentra.app"}), false)
  assert.equal(isPortableMacPackage({app: "Mentra.app", launcherPath: "launch-ios-on-mac"}), true)
  const native = {app: "Mentra.app", macPackageVersion: 2, macInstaller: "Install Mentra.app"}
  assert.equal(isPortableMacPackage(native), true)
  assert.throws(() => isPortableMacPackage({...native, launcherPath: "old-helper"}), /layout/)
  assert.throws(() => isPortableMacPackage({...native, macInstaller: "../other.app"}), /layout/)
  assert.throws(() => isPortableMacPackage({...native, macPackageVersion: 3}), /Unsupported/)
})

test(
  "a native Mac ZIP requires a pinned host helper before changing the installation",
  {skip: process.platform !== "darwin"},
  async () => {
    const root = await fixture()
    await mkdir(root, {recursive: true})
    const manifest = path.join(root, "build.json")
    await writeFile(
      manifest,
      JSON.stringify({
        app: "Mentra.app",
        bundleId: "com.mentra.mentra",
        executableSha256: "a".repeat(64),
        macPackageVersion: 2,
        macInstaller: "Install Mentra.app",
      }),
    )
    await assert.rejects(installBuild(manifest), /open Install Mentra.app.*--launcher/)
  },
)

test("reuse the same managed installation across builds", async () => {
  const root = await fixture()
  await claimInstallation(root, "com.mentra.mentra")
  await writeFile(path.join(root, "retained.txt"), "existing installation")
  await claimInstallation(root, "com.mentra.mentra")
  assert.equal(await readFile(path.join(root, "retained.txt"), "utf8"), "existing installation")
})

test("refuse an existing directory without this installer's marker", async () => {
  const root = await fixture()
  await mkdir(root, {recursive: true})
  await writeFile(path.join(root, "retained.txt"), "unrelated data")
  await assert.rejects(claimInstallation(root, "com.mentra.mentra"))
  assert.equal(await readFile(path.join(root, "retained.txt"), "utf8"), "unrelated data")
})

test("refuse another bundle and a symlinked installation", async () => {
  const root = await fixture()
  await claimInstallation(root, "another.bundle")
  await assert.rejects(claimInstallation(root, "com.mentra.mentra"), /not owned/)
  const alias = path.join(path.dirname(root), "alias")
  await symlink(root, alias)
  await assert.rejects(claimInstallation(alias, "another.bundle"), /real directory/)
})

async function replacementFixture(existing = true) {
  const root = await fixture()
  await claimInstallation(root, "com.mentra.mentra")
  const staging = path.join(root, ".staging-test")
  const lock = path.join(root, ".install-lock")
  await mkdir(path.join(staging, "Mentra.app"), {recursive: true})
  await mkdir(lock)
  await writeFile(path.join(staging, "Mentra.app", "binary"), "new")
  await writeFile(path.join(staging, "installed-build.json"), "new manifest")
  if (existing) {
    await mkdir(path.join(root, "Mentra.app"))
    await writeFile(path.join(root, "Mentra.app", "binary"), "old")
    await writeFile(path.join(root, "installed-build.json"), "old manifest")
  }
  return {root, staging, lock}
}

test("commit promotes the matching app and manifest together", async () => {
  const paths = await replacementFixture()
  await commitStagedInstallation(paths)
  assert.equal(await readFile(path.join(paths.root, "Mentra.app", "binary"), "utf8"), "new")
  assert.equal(await readFile(path.join(paths.root, "installed-build.json"), "utf8"), "new manifest")
  assert.equal(await readFile(path.join(paths.lock, "previous.app", "binary"), "utf8"), "old")
})

test("manifest promotion failure restores the existing app and manifest", async () => {
  const paths = await replacementFixture()
  await assert.rejects(
    commitStagedInstallation(paths, async (from, to) => {
      if (from.endsWith("installed-build.json")) throw new Error("injected manifest failure")
      return rename(from, to)
    }),
    /manifest failure/,
  )
  assert.equal(await readFile(path.join(paths.root, "Mentra.app", "binary"), "utf8"), "old")
  assert.equal(await readFile(path.join(paths.root, "installed-build.json"), "utf8"), "old manifest")
  assert.equal(await readFile(path.join(paths.staging, "Mentra.app", "binary"), "utf8"), "new")
})

test("a failed first install leaves no unmatched live app", async () => {
  const paths = await replacementFixture(false)
  await assert.rejects(
    commitStagedInstallation(paths, async (from, to) => {
      if (from.endsWith("installed-build.json")) throw new Error("injected manifest failure")
      return rename(from, to)
    }),
    /manifest failure/,
  )
  await assert.rejects(readFile(path.join(paths.root, "Mentra.app", "binary")), {code: "ENOENT"})
  await assert.rejects(readFile(path.join(paths.root, "installed-build.json")), {code: "ENOENT"})
  assert.equal(await readFile(path.join(paths.staging, "Mentra.app", "binary"), "utf8"), "new")
})

test("failed rollback retains both generations for recovery", async () => {
  const paths = await replacementFixture()
  await assert.rejects(
    commitStagedInstallation(paths, async (from, to) => {
      if (from.endsWith("installed-build.json")) throw new Error("injected manifest failure")
      if (from === path.join(paths.root, "Mentra.app") && to.startsWith(paths.staging))
        throw new Error("injected rollback failure")
      return rename(from, to)
    }),
    InstallationRollbackError,
  )
  assert.equal(await readFile(path.join(paths.lock, "previous.app", "binary"), "utf8"), "old")
  assert.equal(await readFile(path.join(paths.root, "Mentra.app", "binary"), "utf8"), "new")
  assert.equal(await readFile(path.join(paths.root, "installed-build.json"), "utf8"), "old manifest")
  assert.equal(await readFile(path.join(paths.staging, "installed-build.json"), "utf8"), "new manifest")
})
