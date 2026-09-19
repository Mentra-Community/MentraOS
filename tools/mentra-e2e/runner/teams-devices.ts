import type {Page} from "playwright-core"

export interface TeamsDevices {
  schemaVersion: 1
  microphone: string
  camera: string
  speaker: string
}

export function parseTeamsDevices(value: unknown): TeamsDevices {
  const data = value as Partial<TeamsDevices> | null
  if (
    data?.schemaVersion !== 1 ||
    [data.microphone, data.camera, data.speaker].some(
      (label) => typeof label !== "string" || !label.trim() || /^(default|communications)(\b|$)/i.test(label),
    )
  )
    throw new Error("Teams device fixture requires schemaVersion 1 and three exact, non-default labels")
  return data as TeamsDevices
}

/** Normal Teams prejoin controls; this never changes macOS defaults or joins. */
export async function selectTeamsDevices(
  page: Page,
  devices: TeamsDevices,
  evidence: (id: string, instruction: string) => Promise<void>,
) {
  for (const [kind, title, label] of [
    ["microphone", "Microphone", devices.microphone],
    ["speaker", "Speaker", devices.speaker],
    ["camera", "Camera", devices.camera],
  ]) {
    const button =
      kind === "camera"
        ? page.getByRole("button", {name: "Open video options", exact: true})
        : page.getByRole("button", {name: new RegExp(`^Selected ${kind}: .*open ${kind} options$`)})
    await button.click()
    const options = page.getByRole("listbox", {name: title, exact: true})
    const option = options.getByRole("option", {name: label, exact: true})
    await option.waitFor({state: "visible"})
    if ((await option.count()) !== 1) throw new Error(`Ambiguous Teams ${kind}`)
    await option.click()
    // Teams keeps these device dialogs open after selection.
    await page.keyboard.press("Escape")
    if (kind !== "camera") {
      await page
        .getByRole("button", {name: `Selected ${kind}: ${label}, open ${kind} options`, exact: true})
        .waitFor({state: "visible"})
    } else {
      const cameraOn = page.getByRole("switch", {name: /^Turn camera on/})
      if (await cameraOn.isVisible()) await cameraOn.click()
      // Actual preview track confirms the selected camera while still outside the call.
      const deadline = Date.now() + 10000
      while (true) {
        const labels = await page.locator("video").evaluateAll((videos) =>
          videos
            .map((video) => video as HTMLVideoElement)
            .flatMap((video) =>
              video.srcObject instanceof MediaStream
                ? video.srcObject
                    .getVideoTracks()
                    .filter((track) => track.readyState === "live")
                    .map((track) => track.label)
                : [],
            ),
        )
        if (labels.includes(label)) break
        if (Date.now() > deadline) throw new Error(`Teams preview did not open the selected camera: ${label}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    await evidence(`device-${kind}`, `Select and verify ${label} in Teams before joining.`)
  }
}
