import {firmwareUpdates, firmwareUpdateService} from "../../facades/firmwareUpdates"
import {FirmwareUpdateError, type FirmwareOpenOptions, type FirmwareTarget} from "../../ota/types"
import {MentraLiveFirmwareProvider} from "./provider"

let current: MentraLiveFirmwareProvider | null = null

/** Passive compatibility lookup. Native identity is resolved before a provider is selected. */
export async function resolveMentraLiveOtaProvider(
  requestedTarget?: FirmwareTarget,
): Promise<MentraLiveFirmwareProvider> {
  const target = requestedTarget ?? (await firmwareUpdates.currentTarget())
  if (target.integrationId !== "mentra-live")
    throw new FirmwareUpdateError("unsupported", "The Live update flow requires Mentra Live glasses")
  const provider = firmwareUpdateService.provider(target)
  if (!(provider instanceof MentraLiveFirmwareProvider))
    throw new FirmwareUpdateError("invalid_provider", "The registered Live updater has no Live presentation")
  current = provider
  return provider
}

export function getMentraLiveOtaSession() {
  return current?.session ?? null
}

export async function openMentraLiveOtaProvider(
  options: FirmwareOpenOptions,
  target?: FirmwareTarget,
): Promise<MentraLiveFirmwareProvider> {
  const provider = await resolveMentraLiveOtaProvider(target)
  await firmwareUpdates.open(provider.target, options)
  return provider
}

export function releaseMentraLiveOtaSession(): void {
  if (!current) return
  firmwareUpdateService.release(current.target)
  current = null
}
