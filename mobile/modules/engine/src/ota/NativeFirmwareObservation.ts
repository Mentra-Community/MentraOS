import type {NativeFirmwareUpdateSnapshot} from "@mentra/bluetooth-sdk/firmware-updates"

export interface NativeFirmwareObservationPorts {
  read(): Promise<NativeFirmwareUpdateSnapshot>
  listen(listener: (value: NativeFirmwareUpdateSnapshot) => void): () => void
}

/** Registers before reading, then replays only revisions belonging to the native-authoritative updater. */
export class NativeFirmwareObservation {
  private current: NativeFirmwareUpdateSnapshot | null = null
  private buffered = new Map<string, NativeFirmwareUpdateSnapshot>()
  private remove: (() => void) | null = null
  private pending: Promise<void> | null = null
  private disposed = false

  constructor(
    private readonly identity: {deviceId: string; integrationId: string},
    private readonly ports: NativeFirmwareObservationPorts,
    private readonly changed: (value: NativeFirmwareUpdateSnapshot) => void,
    private readonly failed: (error: unknown) => void,
  ) {}

  async start(): Promise<void> {
    if (this.disposed) throw new Error("Firmware observation has ended")
    if (!this.remove) this.remove = this.ports.listen(this.receive)
    await this.refresh()
  }

  snapshot(): NativeFirmwareUpdateSnapshot | null {
    return this.current
  }

  /** Command responses are also ordered against events already delivered by native. */
  accept(value: NativeFirmwareUpdateSnapshot): void {
    this.receive(value)
  }

  /** A direct read already identifies the selected native updater; events still require that lookup. */
  acceptRead(value: NativeFirmwareUpdateSnapshot): void {
    if (!this.matches(value)) throw new Error("Firmware snapshot belongs to another device")
    this.publish(value)
  }

  dispose(): void {
    this.disposed = true
    this.remove?.()
    this.remove = null
    this.buffered.clear()
  }

  private matches(value: NativeFirmwareUpdateSnapshot): boolean {
    return (
      value.schemaVersion === 1 &&
      value.deviceId === this.identity.deviceId &&
      value.integrationId === this.identity.integrationId &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0
    )
  }

  private publish(value: NativeFirmwareUpdateSnapshot): void {
    if (this.disposed) return
    if (this.current?.updaterId === value.updaterId && this.current.revision >= value.revision) return
    // A process-global native connection generation also fences delayed responses from replaced SGCs.
    if (this.current && value.connectionGeneration < this.current.connectionGeneration) return
    this.current = value
    this.changed(value)
  }

  private receive = (value: NativeFirmwareUpdateSnapshot): void => {
    if (this.disposed || !this.matches(value)) return
    if (this.current && value.connectionGeneration < this.current.connectionGeneration) return
    if (this.current?.updaterId === value.updaterId) {
      this.publish(value)
      return
    }
    const prior = this.buffered.get(value.updaterId)
    if (!prior || value.revision > prior.revision) this.buffered.set(value.updaterId, value)
    if (this.buffered.size > 16) this.buffered.delete(this.buffered.keys().next().value!)
    // A different updater ID is adopted only after querying the currently selected native SGC.
    if (this.current) void this.refresh().catch(this.failed)
  }

  private refresh(): Promise<void> {
    if (this.pending) return this.pending
    const beforeRead = new Map(this.buffered)
    const read = this.ports.read().then((value) => {
      if (this.disposed) return
      if (!this.matches(value)) throw new Error("Firmware snapshot belongs to another device")
      const buffered = this.buffered.get(value.updaterId)
      this.publish(buffered && buffered.revision > value.revision ? buffered : value)
      for (const [id, pending] of this.buffered) {
        if (pending.connectionGeneration <= value.connectionGeneration || beforeRead.get(id) === pending)
          this.buffered.delete(id)
      }
    })
    this.pending = read
      .finally(() => {
        this.pending = null
      })
      .then(async () => {
        // A replacement can emit its first event while the old SGC's read is still in flight.
        if (!this.disposed && this.buffered.size) await this.refresh()
      })
    return this.pending
  }
}
