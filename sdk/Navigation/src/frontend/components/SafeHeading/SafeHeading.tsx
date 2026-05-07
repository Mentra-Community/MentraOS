import {useRef} from "react"

const isAndroid = /android/i.test(navigator.userAgent)

export const safeHeadingSearchPill = isAndroid ? "mt-1" : "mt-9.5"
export const safeHeadingSearchResults = isAndroid ? "pt-20" : "pt-30"
export const safeHeadingAddPlaces = isAndroid ? "pt-8" : "pt-16"
export const safeHeadingManuverCard = isAndroid ? "mt-2" : "mt-11"



export function SafeHeading() {
  const ref = useRef(null)
  return <div ref={ref} style={{height: isAndroid ? 50 : 100}} />
}
