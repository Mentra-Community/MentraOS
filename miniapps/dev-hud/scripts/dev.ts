import {networkInterfaces} from "os"
import {join} from "path"

const root = join(import.meta.dir, "..")
const port = process.env.DEV_HUD_PORT ?? "3147"
const endpoint = process.env.MENTRA_PUBLIC_DEV_HUD_ENDPOINT ?? `http://${localIpAddress() ?? "127.0.0.1"}:${port}`

console.log(`[dev-hud] endpoint for phone/glasses: ${endpoint}`)
console.log("[dev-hud] starting sidecar and miniapp dev server")

const children: Bun.Subprocess[] = []

const sidecar = spawn("sidecar", ["bun", "--watch", "sidecar/index.ts"], {
  DEV_HUD_PORT: port,
  DEV_HUD_PUBLIC_ENDPOINT: endpoint,
})

await Bun.sleep(500)

const miniapp = spawn("miniapp", ["bun", "run", "miniapp:dev"], {
  MENTRA_PUBLIC_DEV_HUD_ENDPOINT: endpoint,
})

const cleanup = () => {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }
}

process.on("SIGINT", () => {
  cleanup()
  process.exit(130)
})
process.on("SIGTERM", () => {
  cleanup()
  process.exit(143)
})

const exitCode = await Promise.race([sidecar.exited, miniapp.exited])
cleanup()
process.exit(exitCode ?? 0)

function spawn(name: string, command: string[], env: Record<string, string>): Bun.Subprocess {
  console.log(`[dev-hud] ${name}: ${command.join(" ")}`)
  const child = Bun.spawn(command, {
    cwd: root,
    env: {...process.env, ...env},
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  children.push(child)
  return child
}

function localIpAddress(): string | null {
  const nets = networkInterfaces()
  for (const name of ["en0", "en1", "bridge100"]) {
    const found = nets[name]?.find((entry) => entry.family === "IPv4" && !entry.internal)
    if (found) return found.address
  }
  for (const entries of Object.values(nets)) {
    const found = entries?.find((entry) => entry.family === "IPv4" && !entry.internal)
    if (found) return found.address
  }
  return null
}
