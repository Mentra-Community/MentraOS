export function acquireAppOwnership(folder?: string, options?: {installer?: boolean}): Promise<() => Promise<void>>
