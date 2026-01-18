declare module "localtunnel" {
  interface TunnelOptions {
    port: number
    subdomain?: string
    host?: string
    local_host?: string
    local_https?: boolean
    local_cert?: string
    local_key?: string
    local_ca?: string
    allow_invalid_cert?: boolean
  }

  interface Tunnel {
    url: string
    on(event: "request", listener: (info: {method?: string; path?: string}) => void): void
    on(event: "error", listener: (err: Error) => void): void
    on(event: "close", listener: () => void): void
    close(): void
  }

  function localtunnel(options: TunnelOptions): Promise<Tunnel>

  export default localtunnel
}
