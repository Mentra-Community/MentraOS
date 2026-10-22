import net from "node:net"

/**
 * @param {number} port
 * @param {string} [host]
 */
export function isPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen(port, host)
  })
}

/**
 * First free port in [preferred, preferred + maxAttempts).
 * @param {number} [preferred]
 * @param {number} [maxAttempts]
 */
export async function resolveMetroPort(preferred = 8081, maxAttempts = 20) {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const port = preferred + offset
    if (await isPortAvailable(port)) {
      return port
    }
  }
  throw new Error(`No free Metro port found in ${preferred}–${preferred + maxAttempts - 1}`)
}
