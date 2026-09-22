#!/usr/bin/env python3
"""Verify a selected PR's Mac artifact; optionally install with trusted host tools."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import zipfile

REPOSITORY = "Mentra-Community/MentraOS"
WORKFLOW = ".github/workflows/mentra-app-ios-build.yml"
BUNDLE = "com.mentra.mentra"
TEAM = "T5XXXL6N36"
MAC_INSTALLER = "Install Mentra.app"
MAX_UNPACKED = 2 * 1024**3
ROOT = Path(__file__).resolve().parents[2]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(file):
    value = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def write_json(file, value):
    file.write_text(json.dumps(value, indent=2) + "\n")


def validate_run(run, selection):
    require(run.get("id") == selection.run, "GitHub run ID mismatch")
    require(run.get("repository", {}).get("full_name") == REPOSITORY, "Unexpected repository")
    require(run.get("path") == WORKFLOW and run.get("event") == "pull_request", "Unexpected producer workflow")
    require(run.get("status") == "completed" and run.get("conclusion") == "success", "Producer run is not successful")
    require(run.get("head_sha") == selection.head, "Producer head SHA mismatch")
    require(run.get("run_attempt", 0) >= selection.attempt, "Artifact attempt is newer than producer run")


def validate_receipt(receipt, selection):
    expected = {"pr": selection.pr, "headSha": selection.head,
                "runId": selection.run, "runAttempt": selection.attempt}
    require(receipt.get("schemaVersion") == 1, "Unsupported receipt schema")
    app = receipt["app"]
    require(all(receipt.get(key) == value and app.get(key) == value for key, value in expected.items()),
            "Receipt/app selection mismatch")
    require(app.get("bundleId") == BUNDLE and app.get("teamId") == TEAM, "Unexpected app signing identity")
    version = validate_package_layout(app)
    require(not any(key in app for key in ("archivePath", "archiveSha256", "archivedAppName")),
            "CI package cannot redirect the installer to another archive")
    ota = f"https://artifactscdn.mentraglass.com/{REPOSITORY}/releases/pr-builds/ota-pr-{selection.pr}-{selection.head}.json"
    require(app.get("otaManifestUrl") == ota, "Missing or mismatched PR OTA pin")
    hashes = ("executableSha256", "javascriptSha256")
    for key in hashes + (("launcherSha256",) if version == 1 else ()):
        require(bool(re.fullmatch(r"[a-f0-9]{64}", app.get(key, ""))), f"Invalid {key}")
    asset = receipt["artifacts"]["mac"]
    expected_name = f"mentra-ios-mac-pr-{selection.pr}-{selection.head}-{selection.run}-{selection.attempt}.zip"
    require(asset.get("name") == expected_name, "Unexpected archive filename")
    require(bool(re.fullmatch(r"[a-f0-9]{64}", asset.get("sha256", ""))), "Invalid archive hash")
    require(isinstance(asset.get("size"), int) and 0 < asset["size"] <= MAX_UNPACKED, "Invalid archive size")
    return app, asset


def validate_package_layout(app):
    version = app.get("macPackageVersion", 1)
    require(type(version) is int and version in (1, 2), "Unsupported Mac package version")
    require(app.get("app") == "Mentra.app", "Unexpected package layout")
    if version == 1:
        require(app.get("launcherPath") == "launch-ios-on-mac" and "macInstaller" not in app,
                "Unexpected legacy package layout")
    else:
        require(app.get("macInstaller") == MAC_INSTALLER
                and not any(key in app for key in ("launcherPath", "launcherSha256")),
                "Unexpected native installer package layout")
    return version


def extract_package(archive, destination):
    """Extract regular files only; do not execute or import downloaded helpers."""
    with zipfile.ZipFile(archive) as source:
        entries = []
        seen = set()
        total = 0
        for entry in source.infolist():
            name = entry.filename.rstrip("/")
            parts = PurePosixPath(name).parts
            require(name and not name.startswith("/") and "\\" not in name
                    and not any(part in ("", ".", "..") for part in name.split("/")), "Unsafe archive path")
            mode = entry.external_attr >> 16
            kind = stat.S_IFMT(mode)
            require(kind in (0, stat.S_IFREG, stat.S_IFDIR), "Archive contains a link or special file")
            require(name.casefold() not in seen, "Duplicate or case-colliding archive path")
            seen.add(name.casefold())
            total += entry.file_size
            require(total <= MAX_UNPACKED and len(seen) <= 20_000, "Archive exceeds extraction limits")
            # macOS resource-fork metadata is not app code and is never extracted.
            if parts[0] == "__MACOSX":
                continue
            require(parts[0] == "Mentra PR", "Unexpected archive root")
            require(entry.is_dir() == (kind == stat.S_IFDIR) or kind == 0, "Invalid archive entry type")
            entries.append(entry)
        require(entries, "Empty Mac archive")
        destination.mkdir(mode=0o700)
        for entry in entries:
            target = destination / entry.filename
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with source.open(entry) as data, target.open("xb") as output:
                    shutil.copyfileobj(data, output)
                target.chmod(0o700 if (entry.external_attr >> 16) & 0o111 else 0o600)
    return destination / "Mentra PR"


def verify_package(package, app, command):
    version = validate_package_layout(app)
    manifest_bytes = (package / "build.json").read_bytes()
    require(json.loads(manifest_bytes) == app, "Packaged manifest differs from CI receipt")
    bundle = package / "Mentra.app"
    info = plistlib.loads((bundle / "Info.plist").read_bytes())
    executable = info["CFBundleExecutable"]
    require(isinstance(executable, str) and executable not in ("", ".", "..")
            and Path(executable).name == executable, "Invalid app executable path")
    require(info.get("CFBundleIdentifier") == BUNDLE, "App bundle ID mismatch")
    require(info.get("CFBundleVersion") == app.get("build")
            and info.get("CFBundleShortVersionString") == app.get("version"), "App version mismatch")
    files = [(bundle / executable, "executableSha256"),
             (bundle / "main.jsbundle", "javascriptSha256")]
    if version == 1:
        files.append((package / app["launcherPath"], "launcherSha256"))
    for file, key in files:
        require(digest(file) == app[key], f"Hash mismatch: {file.name}")
    config = json.loads((bundle / "EXConstants.bundle/app.config").read_text())
    extra = config.get("extra") or {}
    if "mentraPrBuild" in extra:
        pin = extra["mentraPrBuild"]
        require(isinstance(pin, dict) and pin.get("schemaVersion") == 1
                and pin.get("otaManifestUrl") == app["otaManifestUrl"], "Packaged OTA pin mismatch")
    else:
        require(app["otaManifestUrl"].encode() in (bundle / "main.jsbundle").read_bytes(), "Bundled OTA pin missing")
    command(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(bundle)])
    command(["/usr/bin/codesign", "--verify", "-R",
             f'=anchor apple generic and certificate leaf[subject.OU] = "{TEAM}"', str(bundle)])
    if version == 2:
        installer = package / MAC_INSTALLER
        require((installer / "Contents/Resources/build.json").read_bytes() == manifest_bytes,
                "Native installer is pinned to a different manifest")
        command(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(installer)])
        command(["/usr/bin/codesign", "--verify", "-R",
                 '=anchor apple generic '
                 'and identifier "com.mentra.mac-installer" '
                 'and certificate 1[field.1.2.840.113635.100.6.2.6] exists '
                 'and certificate leaf[field.1.2.840.113635.100.6.1.13] exists '
                 f'and certificate leaf[subject.OU] = "{TEAM}"', str(installer)])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("run", "attempt", "pr"):
        parser.add_argument(f"--{name}", type=int, required=True)
    parser.add_argument("--head", required=True, help="Expected full PR head SHA")
    parser.add_argument("--output", type=Path, required=True, help="New private evidence directory")
    parser.add_argument("--install", action="store_true", help="Replace the managed app after verification")
    parser.add_argument("--no-launch", action="store_true")
    parser.add_argument("--launcher", type=Path, help="Trusted preinstalled host launcher")
    parser.add_argument("--launcher-sha256", help="Previously recorded trusted launcher SHA256")
    args = parser.parse_args(argv)
    require(sys.platform == "darwin", "Requires macOS")
    require(min(args.run, args.attempt, args.pr) > 0 and bool(re.fullmatch(r"[a-f0-9]{40}", args.head)),
            "Invalid PR/run selection")
    require(not args.no_launch or args.install, "--no-launch requires --install")
    require(not args.install or (args.launcher and args.launcher_sha256),
            "Installation requires --launcher and --launcher-sha256 from host provisioning")
    # A fresh private directory prevents accidental mutation of another run.
    os.umask(0o077)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False, mode=0o700)

    def command(argv):
        with (output / "commands.jsonl").open("a") as log:
            log.write(json.dumps({"at": dt.datetime.now(dt.timezone.utc).isoformat(), "command": argv}) + "\n")
            result = subprocess.run(argv, capture_output=True, text=True, timeout=600)
            log.write(json.dumps({"exit": result.returncode, "stdout": result.stdout, "stderr": result.stderr}) + "\n")
        require(result.returncode == 0, f"{argv[0]} failed; see {output / 'commands.jsonl'}")
        return result.stdout

    try:
        producer = json.loads(command(["gh", "api", f"repos/{REPOSITORY}/actions/runs/{args.run}"]))
        validate_run(producer, args)
        write_json(output / "producer.json", producer)
        downloads = output / "download"
        command(["gh", "run", "download", str(args.run), "--repo", REPOSITORY,
                 "--name", f"pr-ios-{args.run}-{args.attempt}", "--dir", str(downloads)])
        receipt_name = f"mentra-ios-pr-{args.pr}-{args.head}-{args.run}-{args.attempt}.json"
        receipt = json.loads((downloads / receipt_name).read_text())
        app, asset = validate_receipt(receipt, args)
        archive = downloads / asset["name"]
        require(archive.is_file() and not archive.is_symlink(), "Archive is not a regular file")
        require(archive.stat().st_size == asset["size"] and digest(archive) == asset["sha256"], "Archive hash/size mismatch")
        package = extract_package(archive, output / "package")
        verify_package(package, app, command)
        proof = {"status": "verified", "selection": {"repository": REPOSITORY, "run": args.run,
                 "attempt": args.attempt, "pr": args.pr, "head": args.head},
                 "archiveSha256": asset["sha256"], "app": app, "manifest": str(package / "build.json"),
                 "permissionReadiness": "not-tested", "installed": False}
        write_json(output / "result.json", proof)
        if args.install:
            installer = ROOT / "mobile/scripts/install-ios-mac.mjs"
            launcher = str(args.launcher.expanduser().absolute())
            cmd = ["bun", str(installer), "--manifest", str(package / "build.json"),
                   "--launcher", launcher, "--launcher-sha256", args.launcher_sha256]
            if args.no_launch:
                cmd.append("--no-launch")
            proof["installerSha256"] = digest(installer)
            print(command(cmd), end="")
            proof.update({"installed": True, "launcher": launcher, "launcherSha256": args.launcher_sha256})
            write_json(output / "result.json", proof)
        print(f"Verified PR #{args.pr} at {args.head}; evidence: {output}")
    except Exception as error:
        write_json(output / "failure.json", {"error": str(error), "permissionReadiness": "not-tested"})
        raise


if __name__ == "__main__":
    main()
