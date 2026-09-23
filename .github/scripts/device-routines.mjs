export const DEVICE_ROUTINES = Object.freeze({
  "day1-ota": Object.freeze({label: "routine:day1-ota", name: "Day-one OTA"}),
  "no-glasses": Object.freeze({label: "routine:no-glasses", name: "No-glasses UI"}),
})

export function deviceRoutine(id) {
  if (!Object.hasOwn(DEVICE_ROUTINES, id)) throw new Error("Unsupported device routine")
  return DEVICE_ROUTINES[id]
}

export function hasRoutineLabel(pr, id) {
  return pr.labels?.some((label) => (typeof label === "string" ? label : label.name) === deviceRoutine(id).label) ?? false
}
