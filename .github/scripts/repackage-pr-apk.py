#!/usr/bin/env python3
"""Reconfigure a signed APK or AAB (a PR's or a release's); compiled entries stay byte-for-byte unchanged."""
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import zipfile

from pr_mobile_config import CONTRACT, read_build, packaged_config, packaging_inputs

KEYSTORE = "mobile/credentials/upload-keystore.jks"


class Layout:
    """Where a format keeps its config and manifest: an APK's binary XML, or an AAB base module's aapt2 protobuf."""

    def __init__(self, bundle):
        self.bundle = bundle
        self.config = "base/assets/app.config" if bundle else "assets/app.config"
        self.manifest = "base/manifest/AndroidManifest.xml" if bundle else "AndroidManifest.xml"

    def version_code(self, xml, replacement=None):
        return (proto_version_code if self.bundle else version_code)(xml, replacement)


def layout(path):
    return Layout(str(path).endswith(".aab"))


def check_version_code(value):
    if not 1 <= value <= 2_100_000_000:
        raise ValueError("Invalid Android build number")


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
            check_version_code(replacement)
            struct.pack_into("<I", data, position, replacement)
            return bytes(data)
        offset += size
    raise ValueError("Missing manifest element")


# An AAB's manifest is aapt2's XmlNode protobuf (Resources.proto): XmlNode.element (1) holds the root's
# XmlAttributes (4), each with namespace_uri (1), name (2), value (3) and compiled_item (6), whose Item.prim (7)
# Primitive.int_decimal_value (6) is the typed value.
ANDROID_NAMESPACE = b"http://schemas.android.com/apk/res/android"


def _varint(data, index):
    value = shift = 0
    while True:
        byte = data[index]
        index += 1
        value |= (byte & 0x7F) << shift
        shift += 7
        if byte < 0x80:
            return value, index


def _encode_varint(value):
    out = bytearray()
    while True:
        byte, value = value & 0x7F, value >> 7
        out.append(byte | 0x80 if value else byte)
        if not value:
            return bytes(out)


def _fields(data):
    """(field, wire type, value, raw bytes) of each field of one protobuf message."""
    index = 0
    while index < len(data):
        start = index
        key, index = _varint(data, index)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, index = _varint(data, index)
        elif wire == 2:
            length, index = _varint(data, index)
            value, index = data[index:index + length], index + length
        elif wire in (1, 5):
            length = 8 if wire == 1 else 4
            value, index = data[index:index + length], index + length
        else:
            raise ValueError("Unexpected protobuf wire type")
        if index > len(data):
            raise ValueError("Truncated protobuf")
        yield field, wire, value, data[start:index]


def _message(field, payload):
    return _encode_varint(field << 3 | 2) + _encode_varint(len(payload)) + payload


def _is_version_code(attribute):
    values = {field: value for field, wire, value, _ in _fields(attribute) if wire == 2}
    return values.get(1) == ANDROID_NAMESPACE and values.get(2) == b"versionCode"


def _int_decimal(item):
    for field, wire, prim, _ in _fields(item):
        if field == 7 and wire == 2:
            values = [value for f, w, value, _ in _fields(prim) if f == 6 and w == 0]
            if len(values) == 1:
                return values[0]
    raise ValueError("versionCode must be an unambiguous typed integer")


def proto_version_code(xml, replacement=None):
    """Read/replace the root element's android:versionCode in an AAB's proto manifest."""
    elements = [value for field, wire, value, _ in _fields(xml) if field == 1 and wire == 2]
    if len(elements) != 1:
        raise ValueError("Expected one manifest element")
    attributes = [value for field, wire, value, _ in _fields(elements[0]) if field == 4 and wire == 2]
    matches = [attribute for attribute in attributes if _is_version_code(attribute)]
    if len(matches) != 1:
        raise ValueError("Expected exactly one versionCode")
    values = {field: value for field, wire, value, _ in _fields(matches[0]) if wire == 2}
    old = _int_decimal(values[6])
    if values.get(3) != str(old).encode():
        raise ValueError("versionCode value and compiled item differ")
    if replacement is None:
        return old
    check_version_code(replacement)

    def attribute(raw):
        out = bytearray()
        for field, wire, value, original in _fields(raw):
            if field == 3:
                out += _message(3, str(replacement).encode())
            elif field == 6:
                item = bytearray()
                for f, w, prim, item_raw in _fields(value):
                    item += _message(7, _encode_varint(6 << 3) + _encode_varint(replacement)) if f == 7 else item_raw
                out += _message(6, bytes(item))
            else:
                out += original
        return bytes(out)

    def element(raw):
        return b"".join(_message(4, attribute(value)) if field == 4 and wire == 2 and _is_version_code(value)
                        else original for field, wire, value, original in _fields(raw))

    return b"".join(_message(1, element(value)) if field == 1 and wire == 2 else original
                    for field, wire, value, original in _fields(xml))


def signature_entry(name):
    return bool(re.fullmatch(r"META-INF/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]+)", name, re.I))


def read_config(archive, files):
    names = archive.namelist()
    if len(names) != len(set(names)):
        raise ValueError("Archive has duplicate entries")
    config = json.loads(archive.read(files.config))
    return config, read_build(config)


def configure(config, *, fingerprint, ota_url, build_number, metadata, identity):
    return packaged_config(config, fingerprint=fingerprint, ota_url=ota_url, build_number=build_number,
                           platform="android", build_info=metadata, identity=identity)


def rewrite(source, destination, **inputs):
    files = layout(source)
    with zipfile.ZipFile(source) as original:
        config, _ = read_config(original, files)
        config = configure(config, **inputs)
        with zipfile.ZipFile(destination, "w") as output:
            for entry in original.infolist():
                if signature_entry(entry.filename):
                    continue
                content = original.read(entry)
                if entry.filename == files.config:
                    content = json.dumps(config, separators=(",", ":")).encode()
                elif entry.filename == files.manifest:
                    content = files.version_code(content, inputs["build_number"])
                output.writestr(entry, content)


def verify_payload(source, output, **inputs):
    files = layout(source)
    with zipfile.ZipFile(source) as before, zipfile.ZipFile(output) as after:
        old_config, _ = read_config(before, files)
        config, build = read_config(after, files)
        expected_config = configure(old_config, **inputs)
        if build != expected_config["extra"][CONTRACT] or build["mobileFingerprint"] != inputs["fingerprint"]:
            raise ValueError("Packaged build config does not match requested inputs")
        build_number = inputs["build_number"]
        if config["android"]["versionCode"] != build_number or files.version_code(after.read(files.manifest)) != build_number:
            raise ValueError("Packaged versionCode mismatch")
        names = {name for name in before.namelist() if not signature_entry(name)}
        if names != {name for name in after.namelist() if not signature_entry(name)}:
            raise ValueError("Payload entry set changed")
        for name in names - {files.config, files.manifest}:
            if before.read(name) != after.read(name):
                raise ValueError(f"Compiled payload changed: {name}")
        if config != expected_config or after.read(files.manifest) != files.version_code(before.read(files.manifest), build_number):
            raise ValueError("Unexpected configuration or manifest changes")


def tool(name):
    return str(Path(os.environ["ANDROID_HOME"]) / "build-tools/36.0.0" / name)


def run(args):
    return subprocess.check_output(args, stderr=subprocess.STDOUT)


def upload_certificate():
    # keytool may print JKS migration warnings on stderr. Only DER bytes belong
    # in the certificate digest.
    cert = subprocess.check_output(["keytool", "-exportcert", "-keystore", KEYSTORE,
                "-alias", os.environ["ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_KEY_ALIAS"],
                "-storepass:env", "ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_STORE_PASSWORD"], stderr=subprocess.PIPE)
    return hashlib.sha256(cert).hexdigest()


def verify_signature(path):
    if layout(path).bundle:
        # Not -strict: an upload key is self-signed, which -strict reports as an error.
        verified = run(["jarsigner", "-verify", str(path)]).decode()
        if "jar verified" not in verified or re.search(r"unsigned entries|jar is unsigned", verified):
            raise ValueError("AAB is not fully signed")
        output = run(["keytool", "-printcert", "-jarfile", str(path)]).decode()
        certs = [value.replace(":", "").lower() for value in re.findall(r"SHA256: ([A-F0-9:]+)", output)]
    else:
        output = run([tool("apksigner"), "verify", "--verbose", "--print-certs", str(path)]).decode()
        certs = re.findall(r"Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)", output)
    if certs != [upload_certificate()]:
        raise ValueError("Signer does not match the upload certificate")


def sign(unsigned, output, temporary):
    """Sign with the upload key: an APK aligned for 16 KB pages with apksigner, an AAB with jarsigner as Gradle does."""
    alias = os.environ["ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_KEY_ALIAS"]
    if layout(output).bundle:
        run(["jarsigner", "-keystore", KEYSTORE, "-storepass:env", "ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_STORE_PASSWORD",
             "-keypass:env", "ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_KEY_PASSWORD", "-digestalg", "SHA-256",
             "-sigalg", "SHA256withRSA", "-signedjar", str(output), str(unsigned), alias])
        return
    aligned = Path(temporary) / "aligned.apk"
    run([tool("zipalign"), "-P", "16", "-f", "4", str(unsigned), str(aligned)])
    run([tool("apksigner"), "sign", "--ks", KEYSTORE, "--ks-key-alias", alias,
         "--ks-pass", "env:ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_STORE_PASSWORD",
         "--key-pass", "env:ORG_GRADLE_PROJECT_MENTRAOS_UPLOAD_KEY_PASSWORD",
         "--v4-signing-enabled", "false", "--out", str(output), str(aligned)])
    run([tool("zipalign"), "-c", "-P", "16", "4", str(output)])


def main():
    mode, source, fingerprint = sys.argv[1:4]
    verify_signature(source)
    with zipfile.ZipFile(source) as archive:
        _, build = read_config(archive, layout(source))
        if build["mobileFingerprint"] != fingerprint:
            raise ValueError("Mobile fingerprint mismatch")
    if mode == "verify-base":
        return
    if mode != "package":
        raise ValueError("Expected verify-base or package")
    output = Path(sys.argv[4])
    if layout(output).bundle != layout(source).bundle:
        raise ValueError("Package an APK as an APK and an AAB as an AAB")
    output.parent.mkdir(parents=True, exist_ok=True)
    inputs = dict(fingerprint=fingerprint, **packaging_inputs())
    with tempfile.TemporaryDirectory(prefix="mentra-android-package-") as tmp:
        unsigned = Path(tmp) / ("unsigned.aab" if layout(source).bundle else "unsigned.apk")
        rewrite(source, unsigned, **inputs)
        sign(unsigned, output, tmp)
        verify_signature(output)
        verify_payload(source, output, **inputs)
    print("Verified the packaged configuration, versionCode, unchanged compiled payload and upload signature")


if __name__ == "__main__":
    main()
