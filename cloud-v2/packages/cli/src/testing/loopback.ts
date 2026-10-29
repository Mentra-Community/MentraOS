/**
 * @fileoverview Helpers for tests of the CLI's loopback sign-in: raw requests
 * to the loopback listener with any `Host`, and a check that no test leaves a
 * listener on the CLI's ports.
 *
 * Another process, or an outbound connection's ephemeral source port, may hold
 * one of the CLI's ports on a shared machine (a CI runner): tests take the
 * ports free when they start (`freeLoopbackPorts`) as the ones the CLI will use,
 * and check only those afterwards.
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

/** The CLI's loopback ports that can be listened on right now, in the CLI's order of preference. */
export async function freeLoopbackPorts(): Promise<number[]> {
  const free: number[] = []
  for (const port of CLI_LOOPBACK_PORTS) {
    try {
      await (await occupy(port))()
      free.push(port)
    } catch {
      // Held by someone else.
    }
  }
  return free
}

/**
 * Fail when any of `ports` (by default all of the CLI's; pass the ones free
 * before the test) is still held, for example by a listener a test leaked.
 */
export async function expectLoopbackPortsFree(ports: readonly number[] = CLI_LOOPBACK_PORTS): Promise<void> {
  const held: number[] = []
  for (const port of ports) {
    try {
      const release = await occupy(port)
      await release()
    } catch {
      held.push(port)
    }
  }
  if (held.length > 0) throw new Error(`loopback ports still in use: ${held.join(", ")}`)
}
