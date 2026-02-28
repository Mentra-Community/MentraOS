import { ChevronDown } from "lucide-react"
import { useRef, useEffect, useState } from "react"

// eslint-disable-next-line no-restricted-imports
import { Transcript } from "../hooks/useTranscripts"

import { TranscriptItem } from "./TranscriptItem"
import { EmptyState } from "./EmptyState"
// import {Button} from "@/components/ui/button"

interface TranscriptListProps {
  transcripts: Transcript[]
  isRecording: boolean
  onToggleRecording: () => void
  onClearTranscripts: () => void
}

export function TranscriptList({ transcripts, isRecording, onToggleRecording, onClearTranscripts }: TranscriptListProps) {
  const [autoScroll, setAutoScroll] = useState(true)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  const handleScroll = () => {
    if (!scrollContainerRef.current) return

    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50

    setAutoScroll(isAtBottom)
  }

  useEffect(() => {
    if (autoScroll && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight
    }
  }, [transcripts, autoScroll])

  const scrollToBottom = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({
        top: scrollContainerRef.current.scrollHeight,
        behavior: "smooth",
      })
    }
  }

  return (
    <div className="h-full w-full flex flex-col relative">
      <div ref={scrollContainerRef} onScroll={handleScroll} className="h-full overflow-y-auto px-6 py-3 space-y-1.5">
        {transcripts.length === 0 ? (
          (
            <>
              <EmptyState />
            </>
          )
        ) : (
          transcripts.map((transcript, index) => (
            <TranscriptItem
              key={transcript.id}
              transcript={transcript}
              isFirst={index === 0}
              isLast={index === transcripts.length - 1}
            />
          ))
        )}
      </div>

      {/* Scroll to bottom FAB */}
      {!autoScroll && transcripts.length > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-6 right-6 w-12 h-12 bg-[#6DAEA6] hover:bg-[#6DAEA6]/95 text-white rounded-full shadow-lg flex items-center justify-center transition-all z-10">
          <ChevronDown className="w-5 h-5" />
        </button>
      )}
    </div>
  )
}
