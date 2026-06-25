import {useRef} from "react"

const isAndroid = /android/i.test(navigator.userAgent)

export const safeHeadingSearchPill = isAndroid ? "mt-4" : "mt-9.5"
export const safeHeadingSearchResults = isAndroid ? "pt-24" : "pt-34"
export const safeHeadingAddPlaces = isAndroid ? "pt-12" : "pt-16"
export const safeHeadingManuverCard = isAndroid ? "mt-17" : "mt-23"
export const safeSuggestionsTop = isAndroid ? "top-40" : "top-45"



export function SafeHeading() {
  const ref = useRef(null)
  return <div ref={ref} style={{height: isAndroid ? 50 : 100}} />
}
