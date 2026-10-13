/**
 * @fileoverview Helpers for tests of the CLI's loopback sign-in: raw requests
 * to the loopback listener with any `Host`, and a check that no test leaves a
 * listener on the CLI's ports.
 */

import {connect, createServer, type Server} from "node:net"

import {CLI_LOOPBACK_PORTS} from "../loopback-login"

/** Send `GET <path>` to 127.0.0.1:`port` with exactly this `Host` header; resolves to the status and body. */
export function rawGet(port: number, path: string, host: string): Promise<{status: number; text: string}> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
    let data = ""
    socket.setEncoding("utf8")
    socket.on("data", chunk => (data += chunk))
    socket.on("error", reject)
    socket.on("end", () => {
      const [head = "", ...body] = data.split("\r\n\r\n")
      const status = Number(head.split(" ")[1])
      resolve({status, text: body.join("\r\n\r\n")})
    })
  })
}

/** Hold 127.0.0.1:`port` until the returned function is called. */
export async function occupy(port: number): Promise<() => Promise<void>> {
  const server: Server = createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve())
  })
  return () => new Promise<void>(resolve => server.close(() => resolve()))
}

/** Fail when any of the CLI's loopback ports is still held, for example by a listener a test leaked. */
export async function expectLoopbackPortsFree(): Promise<void> {
  const held: number[] = []
  for (const port of CLI_LOOPBACK_PORTS) {
    try {
      const release = await occupy(port)
      await release()
    } catch {
      held.push(port)
    }
  }
  if (held.length > 0) throw new Error(`loopback ports still in use: ${held.join(", ")}`)
}
