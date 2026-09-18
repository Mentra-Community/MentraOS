#!/usr/bin/env python3
"""PR-only ad hoc export validation and portable iPhone/Mac packaging."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import zipfile

BUNDLE_ID = "com.mentra.mentra"
PROFILE_NAME = f"match AdHoc {BUNDLE_ID}"
HERE = Path(__file__).resolve().parent


def run(*args):
    return subprocess.check_output([str(arg) for arg in args])


def digest(file):
    value = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def read_profile(file):
    return plistlib.loads(run("security", "cms", "-D", "-i", file))


def validate_profile(profile, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    entitlements = profile["Entitlements"]
    team = profile["TeamIdentifier"][0]
    if (profile["ExpirationDate"].replace(tzinfo=dt.timezone.utc) <= now
            or not profile.get("ProvisionedDevices")
            or profile.get("ProvisionsAllDevices")
            or entitlements.get("get-task-allow") is not False
            or entitlements.get("application-identifier") != f"{team}.{BUNDLE_ID}"):
        raise ValueError("Expected an unexpired ad hoc profile for com.mentra.mentra with registered devices")
    return team


def configure(output, keychain):
    profiles = []
    for directory in [Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles",
                      Path.home() / "Library/MobileDevice/Provisioning Profiles"]:
        for file in directory.glob("*.mobileprovision"):
            profile = read_profile(file)
            if profile.get("Name") == PROFILE_NAME:
                profiles.append(profile)
    if not profiles:
        raise ValueError(f"Missing {PROFILE_NAME}. Run fastlane match adhoc with the test devices first; App Store profiles cannot be used.")
    profile = max(profiles, key=lambda value: value["ExpirationDate"])
    team = validate_profile(profile)
    identities = run("security", "find-identity", "-v", "-p", "codesigning", keychain).decode()
    certificates = [hashlib.sha1(cert).hexdigest().upper() for cert in profile["DeveloperCertificates"]]
    certificate = next((cert for cert in certificates if cert in identities), None)
    if certificate is None:
        raise ValueError("No usable private signing identity matches the ad hoc profile in the job keychain")
    output.mkdir(parents=True, exist_ok=True)
    signing = {"profile": profile["UUID"], "team": team, "certificate": certificate}
    (output / "signing.json").write_text(json.dumps(signing))
    with (output / "ExportOptions.plist").open("wb") as stream:
        plistlib.dump({"method": "release-testing", "destination": "export", "signingStyle": "manual",
                      "signingCertificate": certificate, "teamID": team,
                      "provisioningProfiles": {BUNDLE_ID: profile["UUID"]},
                      "thinning": "<none>", "manageAppVersionAndBuildNumber": False,
                      "uploadSymbols": False}, stream)
    print(f"Validated ad hoc profile {profile['Name']}, expires {profile['ExpirationDate']}, {len(profile['ProvisionedDevices'])} devices")


def package(ipa, output):
    output.mkdir(parents=True, exist_ok=True)
    context = {"pr": int(os.environ["PR_NUMBER"]), "headSha": os.environ["PR_HEAD_SHA"],
               "buildSha": run("git", "rev-parse", "HEAD").decode().strip(),
               "runId": int(os.environ["GITHUB_RUN_ID"]), "runAttempt": int(os.environ["GITHUB_RUN_ATTEMPT"])}
    if len(context["headSha"]) != 40 or any(char not in "0123456789abcdef" for char in context["headSha"]):
        raise ValueError("Invalid PR head SHA")
    suffix = f"pr-{context['pr']}-{context['headSha']}-{context['runId']}-{context['runAttempt']}"
    with tempfile.TemporaryDirectory(prefix="mentra-pr-ios-") as tmp:
        root = Path(tmp)
        with zipfile.ZipFile(ipa) as archive:
            if any(Path(name).is_absolute() or ".." in Path(name).parts for name in archive.namelist()):
                raise ValueError("Unsafe IPA entry")
        run("ditto", "-x", "-k", ipa, root / "unpacked")
        apps = list((root / "unpacked/Payload").glob("*.app"))
        if len(apps) != 1:
            raise ValueError("IPA must contain exactly one app")
        app = apps[0]
        info = plistlib.loads((app / "Info.plist").read_bytes())
        if info["CFBundleIdentifier"] != BUNDLE_ID or "iPhoneOS" not in info["CFBundleSupportedPlatforms"]:
            raise ValueError("IPA is not the Mentra iOS device app")
        run("codesign", "--verify", "--deep", "--strict", app)
        run("codesign", "--verify", "-R", "=anchor apple generic", app)
        profile = read_profile(app / "embedded.mobileprovision")
        team = validate_profile(profile)
        executable = app / info["CFBundleExecutable"]
        if executable.parent != app:
            raise ValueError("Invalid executable name")
        manifest = {**context, "bundleId": BUNDLE_ID, "app": "Mentra.app", "backend": "dev",
                    "version": info["CFBundleShortVersionString"], "build": info["CFBundleVersion"],
                    "executableSha256": digest(executable), "javascriptSha256": digest(app / "main.jsbundle"),
                    "profileUUID": profile["UUID"], "profileExpires": profile["ExpirationDate"].isoformat(), "teamId": team}
        mac = root / "Mentra PR"
        mac.mkdir()
        run("ditto", app, mac / "Mentra.app")
        shutil.copy2(HERE.parent.parent / "scripts/install-ios-mac.mjs", mac / "install.mjs")
        launcher = mac / "launch-ios-on-mac"
        run("xcrun", "swiftc", "-parse-as-library", "-O", "-target", "arm64-apple-macosx14.0",
            HERE.parent.parent / "scripts/launch-ios-on-mac.swift", "-o", launcher)
        # Small macOS helper has a local signature; the inner iOS app keeps its Apple signature.
        run("codesign", "--force", "--sign", "-", launcher)
        manifest.update({"launcherPath": "launch-ios-on-mac", "launcherSha256": digest(launcher)})
        (mac / "build.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (mac / "Install.command").write_text('#!/bin/bash\nset -euo pipefail\ncd -- "$(dirname -- "$0")"\nexport PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"\ncommand -v bun >/dev/null || { echo "Install Bun first: https://bun.sh"; exit 1; }\nbun install.mjs --manifest build.json\n')
        (mac / "Install.command").chmod(0o755)
        shutil.copy2(HERE / "README.md", mac / "README.md")
        files = {"iphone": f"mentra-ios-iphone-{suffix}.ipa", "mac": f"mentra-ios-mac-{suffix}.zip"}
        shutil.copy2(ipa, output / files["iphone"])
        run("ditto", "-c", "-k", "--keepParent", mac, output / files["mac"])
        # Verify the delivered Mac ZIP, not only the source staging directory.
        run("ditto", "-x", "-k", output / files["mac"], root / "verify")
        delivered = root / "verify/Mentra PR/Mentra.app"
        run("codesign", "--verify", "--deep", "--strict", delivered)
        if digest(delivered / info["CFBundleExecutable"]) != manifest["executableSha256"] or digest(delivered / "main.jsbundle") != manifest["javascriptSha256"]:
            raise ValueError("Mac ZIP no longer contains the exported signed app")
        receipt = {"schemaVersion": 1, **context, "app": manifest,
                   "artifacts": {kind: {"name": name, "size": (output / name).stat().st_size,
                                        "sha256": digest(output / name)} for kind, name in files.items()}}
        (output / f"mentra-ios-{suffix}.json").write_text(json.dumps(receipt, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["configure", "package"])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--keychain")
    parser.add_argument("--ipa", type=Path)
    args = parser.parse_args()
    if args.mode == "configure":
        if not args.keychain:
            parser.error("configure requires --keychain")
        configure(args.output, args.keychain)
    else:
        if not args.ipa:
            parser.error("package requires --ipa")
        package(args.ipa, args.output)
