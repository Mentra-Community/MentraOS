export const getBatteryIcon = (level: number) => {
  if (level > 75) {
    return "battery-full"
  }
  if (level > 50) {
    return "battery-three-quarters"
  }
  if (level > 25) {
    return "battery-half"
  }
  if (level > 10) {
    return "battery-quarter"
  }
  return "battery-empty"
}

export const getBatteryColor = (level: number) => {
  if (level > 60) {
    return "#4CAF50"
  }
  if (level > 20) {
    return "#FFB300"
  }
  return "#FF5722"
}
