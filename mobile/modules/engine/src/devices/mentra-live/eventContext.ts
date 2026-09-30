/** Native context is attached by the originating SGC, never from the selected device in JS. */
export class LiveEventContext {
  private generations = new Map<string, number>()

  accepts(event: {source_device_id?: string; source_connection_generation?: number}, owner: string | null): boolean {
    const id = event.source_device_id
    const generation = event.source_connection_generation
    // Preserve compatibility with older public SDK hosts that do not include context.
    if (id === undefined && generation === undefined) return true
    if (!id || !Number.isSafeInteger(generation) || generation! < 0 || (owner && id !== owner)) return false
    const previous = this.generations.get(id)
    if (previous !== undefined && generation! < previous) return false
    this.generations.set(id, generation!)
    return true
  }
}
