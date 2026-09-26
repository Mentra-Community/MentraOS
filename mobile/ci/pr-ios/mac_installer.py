"""Build and notarize the native installer shipped in the existing Mac PR ZIP."""
import base64
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
from urllib.error import HTTPError
from urllib.request import build_opener, HTTPRedirectHandler, Request

HERE = Path(__file__).resolve().parent
TEAM = "T5XXXL6N36"
INSTALLER_ID = "com.mentra.mac-installer"
DEVELOPER_ID_REQUIREMENT = (
    '=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists '
    'and certificate leaf[field.1.2.840.113635.100.6.1.13] exists '
    f'and certificate leaf[subject.OU] = "{TEAM}"'
)
CERTIFICATE_SECRETS = ("MAC_INSTALLER_P12_BASE64", "MAC_INSTALLER_P12_PASSWORD")
DOPPLER_RESPONSE_LIMIT = 1024 * 1024


class NoSecretRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        # Never forward service-token authorization to a redirected endpoint.
        return None


def doppler_secret(token, name):
    if name not in CERTIFICATE_SECRETS:
        raise ValueError("Only the two Mac installer certificate secrets may be fetched")
    if not isinstance(token, str) or not re.fullmatch(r"[!-~]{1,4096}", token) or ":" in token:
        raise ValueError("DOPPLER_TOKEN_MOBILE_PRD must be a nonempty service token")
    authorization = base64.b64encode((token + ":").encode("ascii")).decode("ascii")
    request = Request("https://api.doppler.com/v3/configs/config/secret?name=" + name,
                      headers={"Authorization": "Basic " + authorization, "Accept": "application/json"})
    try:
        with build_opener(NoSecretRedirects()).open(request, timeout=20) as response:
            if response.status != 200:
                raise ValueError("Unexpected response status")
            data = response.read(DOPPLER_RESPONSE_LIMIT + 1)
        if len(data) > DOPPLER_RESPONSE_LIMIT:
            raise ValueError("Response exceeds limit")
        payload = json.loads(data.decode("utf-8"))
        if not isinstance(payload, dict) or payload.get("name") != name or payload.get("success") is False:
            raise ValueError("Unexpected secret response")
        value = payload.get("value")
        computed = value.get("computed") if isinstance(value, dict) else None
        if not isinstance(computed, str) or not computed:
            raise ValueError("Missing computed secret")
        return computed
    except Exception as error:
        if isinstance(error, HTTPError):
            error.close()
        # HTTP/JSON exceptions can contain response bodies and credential values.
        # Suppress their context as well as their text in the CI traceback.
        raise ValueError(f"Could not fetch valid {name} from Doppler; check the mobile prd service token and secret") from None


def run(*arguments, input=None, private=False, timeout=180):
    try:
        result = subprocess.run([str(arg) for arg in arguments], input=input, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        # TimeoutExpired includes argv, which may contain private-key passwords.
        raise RuntimeError(f"{Path(arguments[0]).name} timed out") from None
    if result.returncode:
        # Some security commands contain the P12/keychain password. Never include
        # argv or raw secret-import output in a traceback.
        detail = "" if private else ": " + result.stderr.decode(errors="replace").strip()
        raise RuntimeError(f"{Path(arguments[0]).name} failed (exit {result.returncode}){detail}")
    return result.stdout


def sign(keychain, *arguments):
    # Another job may hold this lock for its complete archive. The wrapper has
    # no separate command timeout, so let the CI job bound this signing wait.
    return run(sys.executable, HERE / "keychain-search.py", "run", keychain,
               "codesign", *arguments, timeout=None)


def required_environment(env):
    names = (
        "ASC_API_KEY_P8_B64",
        "ASC_API_KEY_ID",
        "ASC_API_ISSUER_ID",
        "PR_IOS_KEYCHAIN_PASSWORD",
    )
    missing = [name for name in names if not env.get(name)]
    direct = any(name in env for name in CERTIFICATE_SECRETS)
    if direct:
        missing.extend(name for name in CERTIFICATE_SECRETS if not env.get(name))
    elif not env.get("DOPPLER_TOKEN_MOBILE_PRD"):
        missing.append("DOPPLER_TOKEN_MOBILE_PRD (or both MAC_INSTALLER_P12_BASE64 and MAC_INSTALLER_P12_PASSWORD)")
    if missing:
        raise ValueError("Native Mac installer signing requires: " + ", ".join(missing)
                         + ". Provision Developer ID Application signing before enabling this CI change.")
    secrets = {name: env[name] for name in names}
    # Direct local inputs are a pair. Never silently combine an export from one
    # source with a password from the other, including an explicitly empty input.
    secrets.update({name: env[name] if direct else doppler_secret(env["DOPPLER_TOKEN_MOBILE_PRD"], name)
                    for name in CERTIFICATE_SECRETS})
    try:
        if not isinstance(secrets["MAC_INSTALLER_P12_BASE64"], str):
            raise ValueError("Invalid export")
        if len(secrets["MAC_INSTALLER_P12_BASE64"]) > DOPPLER_RESPONSE_LIMIT or not decode_secret(secrets["MAC_INSTALLER_P12_BASE64"]):
            raise ValueError("Invalid export")
        password = secrets["MAC_INSTALLER_P12_PASSWORD"]
        if not isinstance(password, str) or not 1 <= len(password) <= 4096 or "\0" in password:
            raise ValueError("Invalid password")
    except Exception:
        raise ValueError("Mac installer certificate credentials are malformed") from None
    return secrets


def select_identity(output):
    matches = re.findall(r'\b([0-9A-F]{40}) "Developer ID Application: [^"\n]+ \(' + TEAM + r'\)"', output)
    if len(matches) != 1:
        raise ValueError("Expected exactly one usable Mentra Developer ID Application identity in the job keychain")
    return matches[0]


def decode_secret(value):
    return base64.b64decode("".join(value.split()), validate=True)


def contains_certificate(pem_output, expected_der):
    """Match certificate bytes, not its potentially shared subject/common name."""
    blocks = re.findall(rb"-----BEGIN CERTIFICATE-----\s*(.*?)\s*-----END CERTIFICATE-----",
                        pem_output, re.DOTALL)
    if pem_output.count(b"-----BEGIN CERTIFICATE-----") != len(blocks):
        raise ValueError("Malformed keychain certificate export")
    try:
        certificates = [base64.b64decode(b"".join(block.split()), validate=True) for block in blocks]
    except ValueError:
        raise ValueError("Malformed keychain certificate export") from None
    return expected_der in certificates


def ensure_intermediate(keychain, certificate):
    # Apple publishes this intermediate as DER. Validate the public certificate
    # before examining only this job's keychain (never the default search list).
    expected = run("openssl", "x509", "-inform", "DER", "-in", certificate, "-outform", "DER")
    if not expected:
        raise ValueError("Empty Developer ID intermediate certificate")
    if contains_certificate(run("security", "find-certificate", "-a", "-p", keychain), expected):
        return
    run("security", "import", certificate, "-k", keychain, "-T", "/usr/bin/codesign")
    if not contains_certificate(run("security", "find-certificate", "-a", "-p", keychain), expected):
        raise ValueError("Developer ID intermediate was not found in the job keychain after import")


def configure(keychain, output, env=os.environ, intermediate=None):
    if intermediate is not None:
        ensure_intermediate(keychain, intermediate)
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
    sign(keychain, "--force", "--options", "runtime", "--timestamp", "--sign", identity,
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
            "CFBundleIconFile": "AppIcon.icns", "LSFileQuarantineEnabled": True,
            "CFBundleURLTypes": [{"CFBundleURLName": INSTALLER_ID,
                                  "CFBundleURLSchemes": ["mentra-install"],
                                  "CFBundleTypeRole": "Viewer"}]}
    (contents / "Info.plist").write_bytes(plistlib.dumps(info))
    run("xcrun", "swiftc", "-parse-as-library", "-O", "-target", "arm64-apple-macosx14.0",
        HERE / "mac-installer/InstallerCore.swift", HERE / "mac-installer/Distribution.swift",
        HERE / "mac-installer/Installer.swift",
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
    sign(settings["keychain"], "--force", "--options", "runtime", "--timestamp", "--sign", settings["identity"],
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
    parser.add_argument("--intermediate", type=Path, help="Apple Developer ID intermediate certificate in DER format")
    options = parser.parse_args()
    configure(options.keychain, options.output, intermediate=options.intermediate)
