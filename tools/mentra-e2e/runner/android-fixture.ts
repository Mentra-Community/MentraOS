export interface AndroidGlassesConnection {
  address: string
  name: string
  classicConnected: boolean
  bleConnected: boolean
}

/** Samsung Android 16's current-device table; saved bonds and event history are insufficient. */
export function verifyAndroidFixture(dump: string, expectedName: string) {
  const devices: AndroidGlassesConnection[] = []
  const result = (passed: boolean, reason: string) => ({passed, expectedName, reason, devices})
  if (!/^Mentra_Live_[0-9A-F]{4}$/.test(expectedName))
    return result(false, "Expected an explicit glasses name such as Mentra_Live_03BE")

  const lines = dump.split(/\r?\n/)
  const start = lines.indexOf("BluetoothRemoteDevices")
  if (start < 0) return result(false, "Unsupported Bluetooth dump: current-device table is missing")
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break
    if (!line.includes("Mentra_Live_")) continue
    // Samsung also prints pipe-delimited bond metadata here; it has no live ACL state.
    if (/^\s+(?:[0-9A-FX]{2}:){5}[0-9A-FX]{2}\s+\|/i.test(line)) continue
    const match = line.match(
      /^\s+((?:[0-9A-FX]{2}:){5}[0-9A-FX]{2})\([^)]*\).*\[ACL BR\/EDR:([YN]) LE:([YN])\].*\]\s+(Mentra_Live_[0-9A-F]{4})\s*$/i,
    )
    if (!match) return result(false, "Unsupported Mentra Live connection row; refusing to infer identity")
    const [, address, classic, ble, name] = match
    if (address.replaceAll(":", "").slice(-4).toUpperCase() !== name.slice(-4).toUpperCase())
      return result(false, "Bluetooth address suffix does not match the glasses name")
    devices.push({
      address: address.toUpperCase(),
      name: `Mentra_Live_${name.slice(-4).toUpperCase()}`,
      classicConnected: classic.toUpperCase() === "Y",
      bleConnected: ble.toUpperCase() === "Y",
    })
  }
  if (!devices.length) return result(false, "No identifiable Mentra Live devices in the current-device table")
  if (new Set(devices.map((device) => device.name)).size !== devices.length)
    return result(false, "Duplicate glasses names make the fixture ambiguous")
  const active = devices.filter((device) => device.classicConnected || device.bleConnected)
  if (active.length !== 1) return result(false, `Expected one connected pair; found ${active.length}`)
  if (active[0].name !== expectedName)
    return result(false, `Wrong glasses connected: ${active[0].name}; expected ${expectedName}`)
  if (!active[0].classicConnected || !active[0].bleConnected)
    return result(false, "The expected glasses need both BLE and Bluetooth Classic connected for Call")
  return result(true, "Expected glasses have both BLE and Bluetooth Classic connections")
}
