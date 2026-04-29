/**
 * `mentra-miniapp dev` hardcodes `server.ts` at the project root, so this
 * file just re-exports the real implementation from `src/backend/`. Keep
 * it thin — all dev-server logic lives in src/backend/server.ts.
 */
import "./src/backend/server"
