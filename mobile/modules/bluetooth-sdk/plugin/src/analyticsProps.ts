import {type BluetoothSdkPluginProps} from "./index"

export interface ResolvedAnalyticsProps {
  /** `undefined` leaves the native default (enabled) untouched. */
  disabled?: boolean
  /** Normalized host lane such as `dev`, `staging`, or `prod`. */
  environment?: string
}

const ENVIRONMENT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function normalizeAnalyticsEnvironment(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (typeof raw !== "string") {
    throw new Error(`@mentra/bluetooth-sdk: analytics.environment must be a string, received ${typeof raw}`)
  }
  const value = raw.trim().toLowerCase()
  if (!ENVIRONMENT_PATTERN.test(value)) {
    throw new Error(
      `@mentra/bluetooth-sdk: analytics.environment "${raw}" must match ${ENVIRONMENT_PATTERN} (for example "dev", "staging", "prod")`,
    )
  }
  return value
}

export function resolveAnalyticsProps(props: BluetoothSdkPluginProps | undefined): ResolvedAnalyticsProps {
  const analytics = props?.analytics
  let disabled: boolean | undefined
  let environment: string | undefined
  if (analytics === false) {
    disabled = true
  } else if (analytics === true) {
    disabled = false
  } else if (typeof analytics === "object" && analytics !== null) {
    if (analytics.enabled !== undefined) disabled = !analytics.enabled
    environment = normalizeAnalyticsEnvironment(analytics.environment)
  }
  return {disabled, environment}
}
