"""Build and notarize the native installer shipped in the existing Mac PR ZIP."""
import base64
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
TEAM = "T5XXXL6N36"
INSTALLER_ID = "com.mentra.mac-installer"
DEVELOPER_ID_REQUIREMENT = (
    '=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists '
    'and certificate leaf[field.1.2.840.113635.100.6.1.13] exists '
    f'and certificate leaf[subject.OU] = "{TEAM}"'
)


def run(*arguments, input=None, private=False):
    try:
        result = subprocess.run([str(arg) for arg in arguments], input=input, capture_output=True, timeout=180)
    except subprocess.TimeoutExpired:
        # TimeoutExpired includes argv, which may contain private-key passwords.
        raise RuntimeError(f"{Path(arguments[0]).name} timed out") from None
    if result.returncode:
        # Some security commands contain the P12/keychain password. Never include
        # argv or raw secret-import output in a traceback.
        detail = "" if private else ": " + result.stderr.decode(errors="replace").strip()
        raise RuntimeError(f"{Path(arguments[0]).name} failed (exit {result.returncode}){detail}")
    return result.stdout


def required_environment(env):
    names = (
        "MAC_INSTALLER_P12_BASE64",
        "MAC_INSTALLER_P12_PASSWORD",
        "ASC_API_KEY_P8_B64",
        "ASC_API_KEY_ID",
        "ASC_API_ISSUER_ID",
        "PR_IOS_KEYCHAIN_PASSWORD",
    )
    missing = [name for name in names if not env.get(name)]
    if missing:
        raise ValueError("Native Mac installer signing requires: " + ", ".join(missing)
                         + ". Provision Developer ID Application signing before enabling this CI change.")
    return {name: env[name] for name in names}


def select_identity(output):
    matches = re.findall(r'\b([0-9A-F]{40}) "Developer ID Application: [^"\n]+ \(' + TEAM + r'\)"', output)
    if len(matches) != 1:
        raise ValueError("Expected exactly one usable Mentra Developer ID Application identity in the job keychain")
    return matches[0]


def decode_secret(value):
    return base64.b64decode("".join(value.split()), validate=True)


def configure(keychain, output, env=os.environ):
    secrets = required_environment(env)
    output.mkdir(parents=True, exist_ok=True)
    private = output / "mac-installer-private"
    private.mkdir(mode=0o700, exist_ok=True)
    p12 = private / "installer.p12"
    p12.write_bytes(decode_secret(secrets["MAC_INSTALLER_P12_BASE64"]))
    p12.chmod(0o600)
    try:
        run("security", "import", p12, "-k", keychain, "-f", "pkcs12", "-P",
            secrets["MAC_INSTALLER_P12_PASSWORD"], "-T", "/usr/bin/codesign", private=True)
    finally:
        p12.unlink(missing_ok=True)
    run("security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k",
        secrets["PR_IOS_KEYCHAIN_PASSWORD"], keychain, private=True)
    identity = select_identity(run("security", "find-identity", "-v", "-p", "codesigning", keychain).decode())
    key = private / "AuthKey.p8"
    key.write_bytes(decode_secret(secrets["ASC_API_KEY_P8_B64"]))
    key.chmod(0o600)
    settings = {"identity": identity, "team": TEAM, "keychain": str(keychain.resolve()),
                "key": str(key.resolve()), "keyId": secrets["ASC_API_KEY_ID"],
                "issuer": secrets["ASC_API_ISSUER_ID"]}
    (output / "mac-signing.json").write_text(json.dumps(settings, indent=2) + "\n")
    # Validate private-key access and notarization credentials before an expensive
    # app compilation. Only a trivial owned probe is signed here.
    probe = private / "signing-probe"
    run("xcrun", "clang", "-x", "c", "-", "-o", probe, input=b"int main(void) { return 0; }\n")
    run("codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity,
        "--keychain", keychain, probe)
    run("codesign", "--verify", "--strict", "-R", DEVELOPER_ID_REQUIREMENT, probe)
    run("xcrun", "notarytool", "history", "--key", key, "--key-id", settings["keyId"],
        "--issuer", settings["issuer"], "--output-format", "json")
    print("Verified Developer ID Application signing and Apple notarization credentials")


def create_app(package, manifest):
    app = package / "Install Mentra.app"
    contents = app / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    resources = contents / "Resources"
    resources.mkdir()
    # Bind the notarized installer to this exact adjacent payload. The iOS app
    # stays OUTSIDE the installer and retains its Apple Distribution signature.
    (resources / "build.json").write_bytes((package / "build.json").read_bytes())
    info = {"CFBundleIdentifier": INSTALLER_ID, "CFBundleName": "Install Mentra",
            "CFBundleDisplayName": "Install Mentra", "CFBundleExecutable": "Installer",
            "CFBundlePackageType": "APPL", "CFBundleShortVersionString": "1.0",
            "CFBundleVersion": manifest["build"], "LSMinimumSystemVersion": "14.0",
            "NSHighResolutionCapable": True, "NSPrincipalClass": "NSApplication",
            "CFBundleIconFile": "AppIcon.icns"}
    (contents / "Info.plist").write_bytes(plistlib.dumps(info))
    run("xcrun", "swiftc", "-parse-as-library", "-O", "-target", "arm64-apple-macosx14.0",
        HERE / "mac-installer/InstallerCore.swift", HERE / "mac-installer/Installer.swift",
        "-o", contents / "MacOS/Installer")
    iconset = package / "installer.iconset"
    iconset.mkdir()
    icon = HERE.parents[1] / "assets/app-icons/ic_launcher.png"
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            suffix = "@2x" if scale == 2 else ""
            run("sips", "-z", size * scale, size * scale, icon, "--out",
                iconset / f"icon_{size}x{size}{suffix}.png")
    run("iconutil", "-c", "icns", iconset, "-o", resources / "AppIcon.icns")
    shutil.rmtree(iconset)
    return app


def notarize(app, settings, diagnostics):
    if settings.get("team") != TEAM or not re.fullmatch(r"[0-9A-F]{40}", settings.get("identity", "")):
        raise ValueError("Invalid Mac signing configuration")
    run("codesign", "--force", "--options", "runtime", "--timestamp", "--sign", settings["identity"],
        "--keychain", settings["keychain"], app)
    run("codesign", "--verify", "--deep", "--strict", "-R", DEVELOPER_ID_REQUIREMENT, app)
    diagnostics.mkdir(parents=True, exist_ok=True)
    submission = diagnostics / "installer-notary.zip"
    run("ditto", "-c", "-k", "--keepParent", app, submission)
    credentials = ["--key", settings["key"], "--key-id", settings["keyId"], "--issuer", settings["issuer"]]
    try:
        result = subprocess.run(["xcrun", "notarytool", "submit", str(submission), *credentials,
                                 "--wait", "--timeout", "15m", "--output-format", "json"],
                                capture_output=True, text=True, timeout=1000)
    except subprocess.TimeoutExpired as error:
        def decoded(value):
            return value.decode(errors="replace") if isinstance(value, bytes) else value
        (diagnostics / "notary-submit.json").write_text(json.dumps({"timeout": True,
            "stdout": decoded(error.stdout), "stderr": decoded(error.stderr)}, indent=2) + "\n")
        raise ValueError("Apple notarization timed out; see notary-submit.json") from None
    (diagnostics / "notary-submit.json").write_text(json.dumps({"exit": result.returncode,
        "stdout": result.stdout, "stderr": result.stderr}, indent=2) + "\n")
    try:
        response = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise ValueError("Apple notarization returned no JSON result; see notary-submit.json") from None
    (diagnostics / "notary-result.json").write_text(json.dumps(response, indent=2) + "\n")
    if result.returncode or response.get("status") != "Accepted":
        if response.get("id"):
            report = run("xcrun", "notarytool", "log", response["id"], *credentials)
            (diagnostics / "notary-log.json").write_bytes(report)
        raise ValueError(f"Mac installer notarization not accepted: {response.get('status')}; see notarization diagnostics")
    if not response.get("id"):
        raise ValueError("Apple notarization response is missing its submission ID")
    run("xcrun", "stapler", "staple", app)
    run("xcrun", "stapler", "validate", app)
    run("spctl", "--assess", "--type", "execute", "--verbose=2", app)
    return {"bundleId": INSTALLER_ID, "teamId": TEAM, "notarizationId": response["id"],
            "notarizationStatus": "Accepted", "stapled": True}


def package_installer(package, manifest, signing_file, diagnostics):
    settings = json.loads(signing_file.read_text())
    return notarize(create_app(package, manifest), settings, diagnostics)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["configure"])
    parser.add_argument("--keychain", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    configure(options.keychain, options.output)
