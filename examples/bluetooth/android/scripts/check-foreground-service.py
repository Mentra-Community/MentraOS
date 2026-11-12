"""Check the final native example manifest, not just its merge directives."""

import sys
import xml.etree.ElementTree as ET

ANDROID = "{http://schemas.android.com/apk/res/android}"
EXPECTED_TYPES = {"connectedDevice", "location", "mediaPlayback", "microphone"}


def check_manifest(root):
    permissions = {node.get(ANDROID + "name") for node in root.findall("uses-permission")}
    if "android.permission.FOREGROUND_SERVICE_DATA_SYNC" in permissions:
        raise ValueError("Merged manifest must not request dataSync foreground-service permission")
    required = {
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE",
        "android.permission.CHANGE_WIFI_STATE",
    }
    if not required <= permissions:
        raise ValueError(f"Missing connectedDevice startup permissions: {required - permissions}")
    services = root.findall("application/service")
    for service in services:
        if "dataSync" in service.get(ANDROID + "foregroundServiceType", "").split("|"):
            raise ValueError("Merged service must not select dataSync")
    sdk_services = [service for service in services if service.get(ANDROID + "name") ==
                    "com.mentra.bluetoothsdk.services.ForegroundService"]
    if len(sdk_services) != 1:
        raise ValueError("Expected exactly one SDK foreground service")
    if set(sdk_services[0].get(ANDROID + "foregroundServiceType", "").split("|")) != EXPECTED_TYPES:
        raise ValueError("SDK service must retain all non-dataSync types")


if __name__ == "__main__":
    check_manifest(ET.parse(sys.argv[1]).getroot())
    print("Foreground-service manifest verified: connectedDevice startup, no dataSync")
