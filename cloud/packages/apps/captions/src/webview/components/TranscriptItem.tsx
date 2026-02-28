import {Transcript} from "@/hooks/useTranscripts"

interface TranscriptItemProps {
  transcript: Transcript
  isFirst: boolean
  isLast: boolean
}

// Speaker colors matching the design
const SPEAKER_COLORS = [
  {bg: "#3183BD", text: "#3183BD"}, // blue
  {bg: "#93A246", text: "#93A246"}, //
  {bg: "#3F7D76", text: "#3F7D76"}, //
  {bg: "#CF7627", text: "#CF7627"}, //
  {bg: "#EC4899", text: "#EC4899"}, //
]

export function TranscriptItem({transcript, isFirst, isLast}: TranscriptItemProps) {
  // Extract speaker number from "Speaker 1", "Speaker 2", etc.
  const speakerNumber = parseInt(transcript.speaker.replace(/\D/g, "")) || 1
  const speakerIndex = (speakerNumber - 1) % SPEAKER_COLORS.length
  const colors = SPEAKER_COLORS[speakerIndex]

  return (
    <div
      className={`self-stretch p-4 bg-white/80 rounded-md flex flex-col gap-1.5
        ${transcript.isFinal ? "opacity-100" : "opacity-80"}
        ${isFirst ? "rounded-t-2xl" : ""}
        ${isLast ? "rounded-b-2xl" : ""}`}>
      {/* Header with speaker badge, name, and timestamp */}
      <div className="flex items-center gap-2">
        {/* Numbered speaker badge */}
        <div
          className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
          style={{backgroundColor: colors.bg, minWidth: "20px"}}>
          <span className="text-white text-[10px] font-bold font-['Red_Hat_Display'] leading-none">
            {speakerNumber}
          </span>
        </div>

        {/* Speaker name */}
        <span className="text-sm font-bold font-['Red_Hat_Display'] leading-5" style={{color: colors.text}}>
          {transcript.speaker}
        </span>

        {/* Timestamp */}
        <span className="text-gray-600 text-xs font-normal font-['Red_Hat_Display'] leading-4 ml-auto">
          {transcript.timestamp || (transcript.isFinal ? "" : "Now")}
        </span>
      </div>

      {/* Transcript text */}
      <p
        className={`self-stretch text-gray-800 text-base font-normal font-['Red_Hat_Display'] leading-6 ${
          transcript.isFinal ? "" : "italic"
        }`}>
        {transcript.text}
      </p>
    </div>
  )
}
