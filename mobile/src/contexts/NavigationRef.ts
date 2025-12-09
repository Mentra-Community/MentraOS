import {createRef} from "react"

import type {NavObject} from "@/contexts/NavigationHistoryContext"

export const navigationRef = createRef<NavObject>()

export function push(path: string, params?: any) {
  navigationRef.current?.push(path, params)
}

export function replace(path: string, params?: any) {
  navigationRef.current?.replace(path, params)
}

export function goBack() {
  navigationRef.current?.goBack()
}

export function navigate(path: string, params?: any) {
  navigationRef.current?.navigate(path, params)
}
