const SPEAKER_COLORS = [
  "bg-blue-50 border-blue-200",
  "bg-purple-50 border-purple-200",
  "bg-green-50 border-green-200",
  "bg-amber-50 border-amber-200",
  "bg-pink-50 border-pink-200",
  "bg-cyan-50 border-cyan-200",
]

export function getSpeakerColor(speaker: string): string {
  const speakerNum = parseInt(speaker.replace("Speaker ", "")) - 1
  return SPEAKER_COLORS[speakerNum % SPEAKER_COLORS.length]
}
