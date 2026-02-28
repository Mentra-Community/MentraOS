// src/telemetry/posthog.ts
import {PostHog} from "posthog-node"

const deploymentRegion = process.env.DEPLOYMENT_REGION
const isChina = deploymentRegion === "china"

export const posthog =
  process.env.POSTHOG_PROJECT_API_KEY && !isChina
    ? new PostHog(
        process.env.POSTHOG_PROJECT_API_KEY!, // project API key
        {
          host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
          flushAt: 20, // batch size
          flushInterval: 5_000, // ms
        },
      )
    : null

if (posthog) {
  console.log("POSTHOG INITIALIZED")
  process.on("beforeExit", async () => posthog.shutdown()) // ensure flush
} else if (isChina) {
  console.log("POSTHOG IS DISABLED FOR CHINA")
}
