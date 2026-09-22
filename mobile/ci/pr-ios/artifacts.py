#!/usr/bin/env python3
"""PR-only ad hoc export validation and portable iPhone/Mac packaging."""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import sys
import subprocess
import tempfile
import zipfile

BUNDLE_ID = "com.mentra.mentra"
PROFILE_NAME = f"match AdHoc {BUNDLE_ID}"
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / ".github/scripts"))
from pr_mobile_config import read_build


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


def signer_certificate(app):
    with tempfile.TemporaryDirectory(prefix="mentra-ios-certificate-") as temp:
        prefix = Path(temp) / "certificate"
        # codesign accepts optional option values only with '='; a separate
        # argument is interpreted as another code object to inspect.
        run("codesign", "-d", f"--extract-certificates={prefix}", app)
        return hashlib.sha1(Path(str(prefix) + "0").read_bytes()).hexdigest().upper()


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


def verify_pr_ota(app, repository, pr, head_sha):
    """Check the shipped pin independently of the build process's environment."""
    if (not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)
            or not isinstance(pr, int) or pr <= 0 or not re.fullmatch(r"[a-f0-9]{40}", head_sha)):
        raise ValueError("Invalid PR OTA coordinates")
    expected = f"https://artifactscdn.mentraglass.com/{repository}/releases/pr-builds/ota-pr-{pr}-{head_sha}.json"
    config = json.loads((app / "EXConstants.bundle/app.config").read_text())
    extra = config.get("extra") or {}
    # Match packagedOtaPin: a packaged PR contract overrides the JS env pin,
    # including an empty intermediate that disables OTA. Never accept that
    # intermediate just because the correct URL also appears in the bundle.
    if "mentraPrBuild" in extra:
        pin = extra["mentraPrBuild"]
        valid = isinstance(pin, dict) and pin.get("schemaVersion") == 1 and pin.get("otaManifestUrl") == expected
    else:
        valid = expected.encode() in (app / "main.jsbundle").read_bytes()
    if not valid:
        raise ValueError("Exported PR app is missing its exact-head glasses OTA pin (OTA disabled or stale)")
    return expected


def configure(output, keychain):
    encoded = os.environ.get("IOS_PR_PROFILE_BASE64")
    if not encoded:
        raise ValueError("Missing IOS_PR_PROFILE_BASE64 Actions secret; upload the registered-device ad hoc profile first")
    output.mkdir(parents=True, exist_ok=True)
    file = output / "PR.mobileprovision"
    file.write_bytes(base64.b64decode(encoded, validate=True))
    profile = read_profile(file)
    if profile.get("Name") != PROFILE_NAME:
        raise ValueError(f"Expected {PROFILE_NAME}")
    team = validate_profile(profile)
    identities = run("security", "find-identity", "-v", "-p", "codesigning", keychain).decode()
    certificates = [hashlib.sha1(cert).hexdigest().upper() for cert in profile["DeveloperCertificates"]]
    certificate = next((cert for cert in certificates if cert in identities), None)
    if certificate is None:
        raise ValueError("No usable private signing identity matches the ad hoc profile in the job keychain")
    # Listing an identity does not prove codesign can use its private key in a
    # headless runner session. Fail here instead of after compiling the app.
    with tempfile.TemporaryDirectory(prefix="mentra-signing-probe-") as temporary:
        probe = Path(temporary) / "probe"
        subprocess.run(["xcrun", "clang", "-x", "c", "-", "-o", str(probe)],
                       input=b"int main(void) { return 0; }\n", check=True)
        try:
            run(sys.executable, HERE / "keychain-search.py", "run", keychain,
                "codesign", "--force", "--verbose=4", "--sign", certificate, "--keychain", keychain,
                "--timestamp=none", probe)
        except subprocess.CalledProcessError:
            # Public metadata and codesign-specific security diagnostics only;
            # never dump keychain contents, private keys or passwords.
            subprocess.run(["security", "list-keychains", "-d", "user"], check=False)
            subprocess.run(["security", "default-keychain", "-d", "user"], check=False)
            subprocess.run(["security", "show-keychain-info", keychain], check=False)
            subprocess.run(["/usr/bin/log", "show", "--last", "1m", "--style", "compact", "--predicate",
                            'process == "securityd" AND (eventMessage CONTAINS[c] "codesign" OR '
                            'eventMessage CONTAINS[c] "CSSM" OR eventMessage CONTAINS[c] "interaction")'],
                           check=False, timeout=20)
            raise
        run("codesign", "--verify", "--strict", "-R", "=anchor apple generic", probe)
        if signer_certificate(probe) != certificate:
            raise ValueError("Signing probe used a different certificate")
    # Xcode 16+ reads profiles here. Keep the named profile separate from the
    # App Store profile; concurrent jobs can use the same Apple-issued UUID.
    installed = Path.home() / "Library/Developer/Xcode/UserData/Provisioning Profiles"
    installed.mkdir(parents=True, exist_ok=True)
    shutil.copy2(file, installed / f"{profile['UUID']}.mobileprovision")
    signing = {"profile": profile["UUID"], "team": team, "certificate": certificate}
    (output / "signing.json").write_text(json.dumps(signing))
    with (output / "ExportOptions.plist").open("wb") as stream:
        plistlib.dump({"method": "release-testing", "destination": "export", "signingStyle": "manual",
                      "signingCertificate": certificate, "teamID": team,
                      "provisioningProfiles": {BUNDLE_ID: profile["UUID"]},
                      "thinning": "<none>", "manageAppVersionAndBuildNumber": False,
                      "uploadSymbols": False}, stream)
    print(f"Validated ad hoc profile {profile['Name']}, expires {profile['ExpirationDate']}, {len(profile['ProvisionedDevices'])} devices")


def package_mac_app(app, output, manifest, folder_name="Mentra PR", readme=None):
    """Share the verified portable Mac package between PR and channel builds."""
    output = Path(output)
    with tempfile.TemporaryDirectory(prefix="mentra-mac-package-") as tmp:
        root = Path(tmp)
        mac = root / folder_name
        mac.mkdir()
        run("ditto", app, mac / "Mentra.app")
        shutil.copy2(HERE.parent.parent / "scripts/install-ios-mac.mjs", mac / "install.mjs")
        launcher = mac / "launch-ios-on-mac"
        run("xcrun", "swiftc", "-parse-as-library", "-O", "-target", "arm64-apple-macosx14.0",
            HERE.parent.parent / "scripts/launch-ios-on-mac.swift", "-o", launcher)
        run("codesign", "--force", "--sign", "-", launcher)
        manifest.update({"launcherPath": "launch-ios-on-mac", "launcherSha256": digest(launcher)})
        (mac / "build.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (mac / "Install.command").write_text('#!/bin/bash\nset -euo pipefail\ncd -- "$(dirname -- "$0")"\nexport PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"\ncommand -v bun >/dev/null || { echo "Install Bun first: https://bun.sh"; exit 1; }\nbun install.mjs --manifest build.json\n')
        (mac / "Install.command").chmod(0o755)
        if readme is None:
            shutil.copy2(HERE / "README.md", mac / "README.md")
        else:
            (mac / "README.md").write_text(readme)
        run("ditto", "-c", "-k", "--keepParent", mac, output)
        run("ditto", "-x", "-k", output, root / "verify")
        delivered = root / "verify" / folder_name / "Mentra.app"
        run("codesign", "--verify", "--deep", "--strict", delivered)
        info = plistlib.loads((delivered / "Info.plist").read_bytes())
        if (digest(delivered / info["CFBundleExecutable"]) != manifest["executableSha256"]
                or digest(delivered / "main.jsbundle") != manifest["javascriptSha256"]):
            raise ValueError("Mac ZIP no longer contains the exported signed app")
        if (delivered / "EXConstants.bundle/app.config").read_bytes() != (app / "EXConstants.bundle/app.config").read_bytes():
            raise ValueError("Mac ZIP configuration changed")


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
        ota_url = verify_pr_ota(app, os.environ["GITHUB_REPOSITORY"], context["pr"], context["headSha"])
        compilation = read_build(json.loads((app / "EXConstants.bundle/app.config").read_text()))
        executable = app / info["CFBundleExecutable"]
        if executable.parent != app:
            raise ValueError("Invalid executable name")
        manifest = {**context, "bundleId": BUNDLE_ID, "app": "Mentra.app", "backend": "dev", "otaManifestUrl": ota_url,
                    "mobileFingerprint": compilation["mobileFingerprint"],
                    "mobileSourceCommit": compilation["mobileSourceCommit"],
                    "reusedCompilation": os.environ.get("PR_IOS_REUSED") == "true",
                    "version": info["CFBundleShortVersionString"], "build": info["CFBundleVersion"],
                    "executableSha256": digest(executable), "javascriptSha256": digest(app / "main.jsbundle"),
                    "profileUUID": profile["UUID"], "profileExpires": profile["ExpirationDate"].isoformat(), "teamId": team}
        files = {"iphone": f"mentra-ios-iphone-{suffix}.ipa", "mac": f"mentra-ios-mac-{suffix}.zip"}
        shutil.copy2(ipa, output / files["iphone"])
        package_mac_app(app, output / files["mac"], manifest)
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
