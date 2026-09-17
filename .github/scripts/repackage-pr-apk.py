#!/usr/bin/env python3
"""Reconfigure a signed PR APK; compiled entries stay byte-for-byte unchanged."""
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
import zipfile

CONFIG = "assets/app.config"
MANIFEST = "AndroidManifest.xml"
CONTRACT = "mentraPrBuild"


def version_code(xml, replacement=None):
    """Read/replace Android's typed integer attribute without rebuilding resources."""
    data = bytearray(xml)
    if len(data) < 8 or struct.unpack_from("<HHI", data) != (3, 8, len(data)):
        raise ValueError("Expected Android binary XML")
    resources = []
    offset = 8
    while offset < len(data):
        kind, header, size = struct.unpack_from("<HHI", data, offset)
        if header < 8 or size < header or offset + size > len(data):
            raise ValueError("Malformed binary XML chunk")
        if kind == 0x180:
            resources = list(struct.unpack_from(f"<{(size-header)//4}I", data, offset + header))
        elif kind == 0x102:  # First start element is the manifest root.
            if header != 16 or size < 36:
                raise ValueError("Unexpected manifest element")
            start, stride, count = struct.unpack_from("<HHH", data, offset + 24)
            if stride != 20 or 16 + start + stride * count > size:
                raise ValueError("Malformed manifest attributes")
            matches = []
            for index in range(count):
                attr = offset + 16 + start + index * stride
                name, raw = struct.unpack_from("<II", data, attr + 4)
                resource = resources[name] if name < len(resources) else 0
                if resource == 0x01010576 and struct.unpack_from("<I", data, attr + 16)[0]:
                    raise ValueError("versionCodeMajor is unsupported")
                if resource == 0x0101021B:  # android.R.attr.versionCode
                    if raw != 0xFFFFFFFF or data[attr + 15] not in (0x10, 0x11):
                        raise ValueError("versionCode must be an unambiguous typed integer")
                    matches.append(attr + 16)
            if len(matches) != 1:
                raise ValueError("Expected exactly one versionCode")
            position = matches[0]
            old = struct.unpack_from("<I", data, position)[0]
            if replacement is None:
                return old
            if not 1 <= replacement <= 2_100_000_000:
                raise ValueError("Invalid Android build number")
            struct.pack_into("<I", data, position, replacement)
            return bytes(data)
        offset += size
    raise ValueError("Missing manifest element")


def signature_entry(name):
    return bool(re.fullmatch(r"META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]+)", name, re.I))


def read_config(apk):
    names = apk.namelist()
    if len(names) != len(set(names)):
        raise ValueError("APK has duplicate entries")
    config = json.loads(apk.read(CONFIG))
    build = config.get("extra", {}).get(CONTRACT, {})
    if build.get("schemaVersion") != 1 or not re.fullmatch(r"[a-f0-9]{64}", build.get("mobileFingerprint", "")):
        raise ValueError("APK does not support PR repackaging")
    if not re.fullmatch(r"[a-f0-9]{40}", build.get("mobileSourceCommit", "")):
        raise ValueError("Missing original mobile source revision")
    return config, build


def rewrite_apk(source, destination, *, fingerprint, ota_url, head_sha, build_number):
    url = urlsplit(ota_url)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.fragment or re.search(r"\s", ota_url):
        raise ValueError("Invalid OTA manifest URL")
    if not re.fullmatch(r"[a-f0-9]{40}", head_sha):
        raise ValueError("Expected full PR head SHA")
    with zipfile.ZipFile(source) as original:
        config, build = read_config(original)
        if build["mobileFingerprint"] != fingerprint:
            raise ValueError("Mobile fingerprint mismatch")
        build.update(otaManifestUrl=ota_url, prHeadSha=head_sha, buildNumber=build_number)
        config.setdefault("android", {})["versionCode"] = build_number
        with zipfile.ZipFile(destination, "w") as output:
            for entry in original.infolist():
                if signature_entry(entry.filename):
                    continue
                content = original.read(entry)
                if entry.filename == CONFIG:
                    content = json.dumps(config, separators=(",", ":")).encode()
                elif entry.filename == MANIFEST:
                    content = version_code(content, build_number)
                output.writestr(entry, content)


def verify_payload(source, output, *, fingerprint, ota_url, head_sha, build_number):
    with zipfile.ZipFile(source) as before, zipfile.ZipFile(output) as after:
        old_config, old_build = read_config(before)
        config, build = read_config(after)
        expected_build = dict(old_build, otaManifestUrl=ota_url, prHeadSha=head_sha, buildNumber=build_number)
        if build != expected_build or build["mobileFingerprint"] != fingerprint:
            raise ValueError("Packaged PR configuration does not match requested inputs")
        if config["android"]["versionCode"] != build_number or version_code(after.read(MANIFEST)) != build_number:
            raise ValueError("Packaged versionCode mismatch")
        names = {name for name in before.namelist() if not signature_entry(name)}
        if names != {name for name in after.namelist() if not signature_entry(name)}:
            raise ValueError("APK payload entry set changed")
        for name in names - {CONFIG, MANIFEST}:
            if before.read(name) != after.read(name):
                raise ValueError(f"Compiled payload changed: {name}")
        old_config["extra"][CONTRACT] = expected_build
        old_config.setdefault("android", {})["versionCode"] = build_number
        if config != old_config or after.read(MANIFEST) != version_code(before.read(MANIFEST), build_number):
            raise ValueError("Unexpected configuration or manifest changes")


def tool(name):
    return str(Path(os.environ["ANDROID_HOME"]) / "build-tools/36.0.0" / name)


def run(args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT)


def verify_signature(apk):
    output = run([tool("apksigner"), "verify", "--verbose", "--print-certs", str(apk)]).decode()
    certs = re.findall(r"Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)", output)
    # keytool may print JKS migration warnings on stderr. Only DER bytes belong
    # in the certificate digest.
    cert = subprocess.check_output(["keytool", "-exportcert", "-keystore", "mobile/credentials/upload-keystore.jks",
                "-alias", os.environ["ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_KEY_ALIAS"],
                "-storepass:env", "ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_STORE_PASSWORD"], stderr=subprocess.PIPE)
    if certs != [hashlib.sha256(cert).hexdigest()]:
        raise ValueError("APK signer does not match the upload certificate")


def main():
    mode, source, fingerprint = sys.argv[1:4]
    verify_signature(source)
    with zipfile.ZipFile(source) as apk:
        _, build = read_config(apk)
        if build["mobileFingerprint"] != fingerprint:
            raise ValueError("Mobile fingerprint mismatch")
    if mode == "verify-base":
        return
    if mode != "package":
        raise ValueError("Expected verify-base or package")
    output = Path(sys.argv[4])
    output.parent.mkdir(parents=True, exist_ok=True)
    inputs = dict(fingerprint=fingerprint, ota_url=os.environ["PR_OTA_MANIFEST_URL"],
                  head_sha=os.environ["PR_HEAD_SHA"], build_number=int(os.environ["MENTRAOS_PINNED_BUILD_NUMBER"]))
    with tempfile.TemporaryDirectory(prefix="mentra-pr-apk-") as tmp:
        unsigned, aligned = Path(tmp) / "unsigned.apk", Path(tmp) / "aligned.apk"
        rewrite_apk(source, unsigned, **inputs)
        run([tool("zipalign"), "-P", "16", "-f", "4", str(unsigned), str(aligned)])
        run([tool("apksigner"), "sign", "--ks", "mobile/credentials/upload-keystore.jks",
             "--ks-key-alias", os.environ["ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_KEY_ALIAS"],
             "--ks-pass", "env:ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_STORE_PASSWORD",
             "--key-pass", "env:ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_KEY_PASSWORD",
             "--v4-signing-enabled", "false", "--out", str(output), str(aligned)])
        verify_signature(output)
        run([tool("zipalign"), "-c", "-P", "16", "4", str(output)])
        verify_payload(source, output, **inputs)
    print("Verified PR configuration, versionCode, unchanged compiled payload, alignment and signing certificate")


if __name__ == "__main__":
    main()
