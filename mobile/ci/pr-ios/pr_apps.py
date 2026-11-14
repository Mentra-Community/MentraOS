"""The iOS side of PR_APPS in .github/scripts/pr-mobile-build.mjs, by MENTRA_PR_APP.

Each app's bundle, the product Xcode builds, the Doppler secret holding its ad
hoc profile, and its Mac package: the folder and the notarized installer that
install it (mac-installer/InstallerCore.swift's PRApp, compiled with `defines`).
"""
import os

PR_APPS = {
    "mentra": {"bundleId": "com.mentra.mentra", "prefix": "mentra", "product": "Mentra.app", "name": "Mentra",
               "profile": "IOS_PR_PROFILE_BASE64", "icon": "mobile/assets/app-icons/ic_launcher.png",
               "installerId": "com.mentra.mac-installer", "scheme": "mentra-install", "defines": []},
    "example": {"bundleId": "com.mentra.bluetoothsdkexample", "prefix": "mentra-example", "product": "MentraBluetoothExample.app",
                "name": "Mentra Example", "profile": "IOS_EXAMPLE_PR_PROFILE_BASE64",
                "icon": "examples/bluetooth/react-native/assets/app-icon.png",
                "installerId": "com.mentra.mac-installer.example", "scheme": "mentra-example-install",
                "defines": ["-D", "MENTRA_EXAMPLE"]},
}


# The dev app (MENTRA_APP_TRACK=dev): the Mentra App under its own identity and
# profile, signed with the dev distribution certificate (DEV in InstallerCore.swift).
MENTRA_DEV = {"bundleId": "com.mentra.mentra.dev", "name": "Mentra Dev", "profile": "IOS_DEV_ADHOC_PROFILE_BASE64",
              "profileName": "Mentra Dev Ad Hoc", "installerId": "com.mentra.mac-installer.dev",
              "scheme": "mentra-dev-install", "defines": ["-D", "MENTRA_DEV"]}


def pr_app(env=os.environ):
    key = env.get("MENTRA_PR_APP") or "mentra"
    app = PR_APPS[key]
    if key == "mentra" and env.get("MENTRA_APP_TRACK") == "dev":
        app = {**app, **MENTRA_DEV}
    # The Mac package's folder and the installer inside it.
    return {**app, "folder": f"{app['name']} PR", "installer": f"Install {app['name']}.app"}


APP = pr_app()
