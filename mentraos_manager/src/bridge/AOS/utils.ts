export function parsePlaceholders(text: string, batteryLevel: number, isWebSocketConnected: boolean): string {
  const now = new Date()

  // Format date and time strings
  const formattedDate = `${now.getMonth() + 1}/${now.getDate()}, ${now.getHours() % 12 || 12}:${now.getMinutes().toString().padStart(2, "0")}`

  // 12-hour time format
  const time12 = `${(now.getHours() % 12 || 12).toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`

  // 24-hour time format
  const time24 = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}`

  // Current date with format MM/dd
  const currentDate = `${(now.getMonth() + 1).toString().padStart(2, "0")}/${now.getDate().toString().padStart(2, "0")}`

  const placeholders: {[key: string]: string} = {
    $no_datetime$: formattedDate,
    $DATE$: currentDate,
    $TIME12$: time12,
    $TIME24$: time24,
    $GBATT$: batteryLevel === -1 ? "" : `${batteryLevel}%`,
    $CONNECTION_STATUS$: isWebSocketConnected ? "Connected" : "Disconnected",
  }

  let result = text
  for (const [key, value] of Object.entries(placeholders)) {
    result = result.replace(new RegExp(key, "g"), value)
  }

  return result
}
