interface BundleEntry {
  name: string
  list?: () => BundleEntry[]
  bytes?: () => Promise<Uint8Array>
}

interface BundleDirectory {
  list: () => BundleEntry[]
}

/** Compare the complete extracted bundle, including extra/missing files. */
export async function sameMiniappBundle(left: BundleDirectory, right: BundleDirectory): Promise<boolean> {
  const expected = left.list()
  const installed = new Map(right.list().map((entry) => [entry.name, entry]))
  if (expected.length !== installed.size) return false
  for (const entry of expected) {
    const other = installed.get(entry.name)
    if (!other) return false
    if (entry.list && other.list) {
      if (!(await sameMiniappBundle({list: () => entry.list!()}, {list: () => other.list!()}))) return false
    } else if (entry.bytes && other.bytes) {
      const [a, b] = await Promise.all([entry.bytes(), other.bytes()])
      if (a.length !== b.length || a.some((byte, index) => byte !== b[index])) return false
    } else {
      return false
    }
  }
  return true
}
