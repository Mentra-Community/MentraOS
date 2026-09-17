import {createHash} from "node:crypto"
import {readFile} from "node:fs/promises"
import {androidCommand} from "./android-session"
import {verifyAndroidFixture} from "./android-fixture"
import {freshBesProof, selectUsbTransport} from "./ota-state"

export interface AndroidRig {
  phone: string
  display: string
  phoneApkSha256: string
  glasses: {serial: string; usb: string; cid: string; bluetooth: string; name: string}
  manifestPath: string
  manifestSha256: string
}
export async function verifyAndroidHardware(rig: AndroidRig, requireTargets: boolean) {
  const bytes = await readFile(rig.manifestPath)
  if (createHash("sha256").update(bytes).digest("hex") !== rig.manifestSha256)
    throw new Error("OTA manifest hash mismatch")
  const manifest = JSON.parse(bytes.toString())
  const target = manifest.apps?.["com.mentra.asg_client"]
  if (!target?.sha256 || !target.versionCode || !manifest.mtk_full_ota?.end_firmware || !manifest.bes_firmware?.version)
    throw new Error("Manifest must pin ASG, MTK and BES")
  const text = async (...args: string[]) => (await androidCommand(["adb", ...args])).toString().trim()
  const transport = selectUsbTransport(await text("devices", "-l"), rig.glasses.serial, rig.glasses.usb)
  const shell = (...args: string[]) => text("-t", transport, "shell", ...args)
  const serial = await shell("getprop", "ro.serialno")
  const cid = await shell("cat", "/sys/block/mmcblk0/device/cid")
  const bluetooth = await shell("getprop", "persist.mentra.live.mac")
  if (
    serial !== rig.glasses.serial ||
    cid.toLowerCase() !== rig.glasses.cid.toLowerCase() ||
    bluetooth.toUpperCase() !== rig.glasses.bluetooth.toUpperCase()
  )
    throw new Error("Glasses USB/Bluetooth identity mismatch")
  const pairing = verifyAndroidFixture(
    await text("-s", rig.phone, "shell", "dumpsys", "bluetooth_manager"),
    rig.glasses.name,
  )
  if (!pairing.passed) throw new Error(pairing.reason)
  const packageHash = async (selector: string[], pkg: string) => {
    const path = await text(...selector, "shell", "pm", "path", pkg)
    if (!/^package:\/[\w./=+~-]+$/.test(path)) throw new Error(`Ambiguous installed package: ${pkg}`)
    return (await text(...selector, "shell", "sha256sum", path.slice(8))).split(/\s+/)[0]
  }
  const phoneHash = await packageHash(["-s", rig.phone], "com.mentra.mentra")
  if (phoneHash !== rig.phoneApkSha256) throw new Error("Installed phone APK differs from candidate")
  const firmware = await shell("getprop", "ro.custom.ota.version")
  const bootId = await shell("cat", "/proc/sys/kernel/random/boot_id")
  const asgVersion = Number(/versionCode=(\d+)/.exec(await shell("dumpsys", "package", "com.mentra.asg_client"))?.[1])
  const asgHash = await packageHash(["-t", transport], "com.mentra.asg_client")
  const logs = await text("-t", transport, "logcat", "-d", "-v", "epoch", "-t", "12000")
  const bes = freshBesProof(logs, bootId, Number(await shell("date", "+%s")))
  const current =
    asgVersion === target.versionCode &&
    asgHash === target.sha256 &&
    firmware === manifest.mtk_full_ota.end_firmware &&
    bes.version === manifest.bes_firmware.version
  if (requireTargets && !current)
    throw new Error("Mandatory OTA target mismatch. Run the separate Android OTA routine before Call.")
  return {
    at: new Date().toISOString(),
    serial,
    cid,
    bluetooth,
    transport,
    pairing,
    phoneHash,
    firmware,
    bootId,
    asgVersion,
    asgHash,
    bes,
    current,
    targets: {
      asgVersion: target.versionCode,
      asgHash: target.sha256,
      firmware: manifest.mtk_full_ota.end_firmware,
      bes: manifest.bes_firmware.version,
    },
  }
}
