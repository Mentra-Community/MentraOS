import {useEffect, useState} from "react"

import {formatAge} from "../utils"

interface RelativeAgeProps {
  emptyLabel?: string
  ms?: number | null
  prefix?: string
}

export function RelativeAge({emptyLabel = "-", ms, prefix = ""}: RelativeAgeProps) {
  const [, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  if (!ms) {
    return <>{emptyLabel}</>
  }

  return (
    <>
      {prefix}
      {formatAge(ms)}
    </>
  )
}
