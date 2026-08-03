import type {ReactNode} from "react"
import {motion} from "motion/react"

import "@/shared/channels"
import type {UnitSystem, VoiceGuidanceMode} from "@/shared/types"
import {useNavStore} from "@/ui/store/navStore"
import {appVersion} from "@/ui/lib/env"
import {safeHeadingAddPlaces} from "@/ui/components/SafeHeading/SafeHeading"
import {BackChevronIcon} from "@/ui/components/icons"
import {toggleDevOverride} from "@/ui/lib/devOverride"
import {useToast} from "@/ui/components/Toast/Toast"

type Props = {
  onClose: () => void
}

/**
 * Settings page. Full-screen slide-in panel mirroring AddPlacePage's
 * chrome (back chevron header, native-back-swipe friendly entry
 * animation).
 */
export function SettingsPage({onClose}: Props) {
  const unitSystem = useNavStore((s) => s.unitSystem)
  const voiceGuidanceMode = useNavStore((s) => s.voiceGuidanceMode)
  const capabilities = useNavStore((s) => s.capabilities)
  const toast = useToast()

  // Tap the version number to toggle the dev override (reveals the
  // FloatingDevPanel). Mirrors the classic "tap the build number" gesture.
  function onTapVersion() {
    const on = toggleDevOverride()
    toast(on ? "Debug mode activated" : "Debug mode deactivated")
  }

  function setUnits(next: UnitSystem) {
    if (next === unitSystem) return
    // Optimistic local update so the toggle feels instant; the background
    // echoes nav:units-update which lands on the same value.
    useNavStore.getState().applyUnitSystem(next)
    mentra.send("nav:set-units", {unitSystem: next})
  }

  function setVoiceGuidance(next: VoiceGuidanceMode) {
    if (!capabilities.hasSpeaker || next === voiceGuidanceMode) return
    useNavStore.getState().applyVoiceGuidance(next)
    mentra.send("nav:set-voice-guidance", {mode: next})
  }

  return (
    <motion.div
      // Slide-in on enter only. iOS WKWebView animates the back-swipe
      // (exit) natively from the snapshot captured at pushState, so we
      // omit `exit` and don't wrap in AnimatePresence — same reasoning
      // as AddPlacePage.
      initial={{x: "100%"}}
      animate={{x: 0}}
      transition={{type: "spring", stiffness: 300, damping: 34, mass: 0.85}}
      className="[font-synthesis:none] fixed inset-0 z-50 flex flex-col bg-white dark:bg-zinc-950 antialiased overflow-hidden">

      {/* Header */}
      <div className={`flex items-center gap-3 px-5 ${safeHeadingAddPlaces} pb-5.5`}>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center size-9 rounded-full bg-[#0000000A] dark:bg-[#FFFFFF14] shrink-0">
          <BackChevronIcon />
        </button>
        <div className="tracking-[-0.02em] font-sans font-bold text-[#1A1A1A] dark:text-zinc-50 text-3xl/9">Settings</div>
      </div>

      <div className="flex-1 overflow-y-auto pb-10">
        {/* UNITS */}
        <Section title="UNITS">
          <div className="flex items-center h-13 px-4 gap-3">
            <div className="grow tracking-[-0.01em] font-sans text-[#1A1A1A] dark:text-zinc-50 text-sm/4.5">Distance</div>
            <UnitsToggle value={unitSystem} onChange={setUnits} />
          </div>
        </Section>

        <Section title="VOICE GUIDANCE">
          <div className="flex flex-col px-4 py-3 gap-2.5">
            <div className="flex items-center gap-3">
              <div className="grow tracking-[-0.01em] font-sans text-[#1A1A1A] dark:text-zinc-50 text-sm/4.5">
                Spoken directions
              </div>
              <VoiceGuidanceToggle
                value={voiceGuidanceMode}
                disabled={!capabilities.hasSpeaker}
                onChange={setVoiceGuidance}
              />
            </div>
            <div className="font-sans text-[#0000008C] dark:text-zinc-400 text-xs/4.5">
              {capabilities.hasSpeaker
                ? "Essential announces turns, rerouting, and arrival. Full also gives advance notice. Tap Repeat or short-press the glasses button during a trip."
                : "The connected glasses do not have a speaker."}
            </div>
          </div>
        </Section>

        {/* ABOUT */}
        <Section title="ABOUT">
          <button
            type="button"
            onClick={onTapVersion}
            className="flex items-center h-13 px-4 gap-3 w-full text-left active:bg-[#00000008] dark:active:bg-[#FFFFFF0F]">
            <div className="grow tracking-[-0.01em] font-sans text-[#1A1A1A] dark:text-zinc-50 text-sm/4.5">Version</div>
            <div className="tracking-[-0.01em] shrink-0 font-sans text-[#0000008C] dark:text-zinc-400 text-sm/4.5">
              {appVersion ? `v${appVersion}` : "—"}
            </div>
          </button>
        </Section>
      </div>
    </motion.div>
  )
}

/** Grouped settings section: uppercase label + rounded card. */
function Section({title, children}: {title: string; children: ReactNode}) {
  return (
    <div className="flex flex-col pt-2 gap-2.25 px-5">
      <div className="pl-1">
        <div className="tracking-[0.06em] font-sans font-semibold text-[#0000008C] dark:text-zinc-400 text-xs/4">{title}</div>
      </div>
      <div className="flex flex-col rounded-2xl overflow-clip [box-shadow:#0000000D_0px_0px_0px_1px_inset] bg-[#F6F6F7] dark:bg-zinc-900">
        {children}
      </div>
    </div>
  )
}

/** Segmented control: Mi (imperial) ⇆ Km (metric). */
function UnitsToggle({value, onChange}: {value: UnitSystem; onChange: (u: UnitSystem) => void}) {
  const options: Array<{id: UnitSystem; label: string}> = [
    {id: "imperial", label: "Mi"},
    {id: "metric", label: "Km"},
  ]
  return (
    <div className="flex items-center shrink-0 rounded-[10px] p-0.5 gap-0.5 bg-[#0000000F] dark:bg-[#FFFFFF1A]">
      {options.map((opt) => {
        const active = value === opt.id
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            aria-pressed={active}
            className={`flex items-center justify-center w-12.5 h-7.5 rounded-lg shrink-0 transition-colors ${
              active ? "[box-shadow:#0000002E_0px_1px_3px] bg-[#1A1A1A] dark:bg-zinc-600" : ""
            }`}>
            <span
              className={`inline-block font-sans text-sm/4.5 ${
                active ? "font-semibold text-white" : "font-medium text-[#0000008C] dark:text-zinc-400"
              }`}>
              {opt.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function VoiceGuidanceToggle({
  value,
  disabled,
  onChange,
}: {
  value: VoiceGuidanceMode
  disabled: boolean
  onChange: (mode: VoiceGuidanceMode) => void
}) {
  const options: Array<{id: VoiceGuidanceMode; label: string}> = [
    {id: "off", label: "Off"},
    {id: "essential", label: "Essential"},
    {id: "full", label: "Full"},
  ]
  return (
    <div
      className={`flex items-center shrink-0 rounded-[10px] p-0.5 gap-0.5 bg-[#0000000F] dark:bg-[#FFFFFF1A] ${
        disabled ? "opacity-45" : ""
      }`}>
      {options.map((opt) => {
        const active = value === opt.id
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.id)}
            aria-pressed={active}
            className={`flex items-center justify-center h-7.5 rounded-lg shrink-0 px-2 transition-colors ${
              active ? "[box-shadow:#0000002E_0px_1px_3px] bg-[#1A1A1A] dark:bg-zinc-600" : ""
            }`}>
            <span
              className={`inline-block font-sans text-xs/4.5 ${
                active ? "font-semibold text-white" : "font-medium text-[#0000008C] dark:text-zinc-400"
              }`}>
              {opt.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
