/** Encode decoded LC3 PCM for native sinks. Hermes has btoa, but no Node Buffer. */
export function pcmToBase64(pcm: ArrayBuffer): string {
  const bytes = new Uint8Array(pcm)
  let binary = ""
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}
