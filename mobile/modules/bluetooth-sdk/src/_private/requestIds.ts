export type CameraRequestIdPrefix = "photo" | "warm"

export function nonBlankRequestId(requestId?: string | null): string | undefined {
  const value = requestId?.trim()
  return value && value.length > 0 ? value : undefined
}

export function generatedCameraRequestId(prefix: CameraRequestIdPrefix): string {
  const timestamp = Date.now().toString(36)
  const random = Math.floor(Math.random() * 0x100000000)
    .toString(36)
    .padStart(7, "0")
  return `${prefix}-${timestamp}-${random}`
}
