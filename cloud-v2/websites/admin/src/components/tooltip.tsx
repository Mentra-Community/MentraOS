import {cloneElement, useId, useState, type ReactElement, type ReactNode} from 'react'

/** Shared hover/focus help. Disabled controls remain keyboard discoverable through their wrapper. */
export function Tooltip({children, content, disabled = false}: {
  children: ReactElement<{"aria-describedby"?: string}>, content: ReactNode, disabled?: boolean
}) {
  const id = useId(), [state, setState] = useState({hover: false, focus: false, dismissed: false})
  const open = !state.dismissed && (state.hover || state.focus)
  return <span className="relative inline-flex" tabIndex={disabled ? 0 : undefined} aria-describedby={disabled ? id : undefined}
    onMouseEnter={() => setState(value => ({...value, hover: true, dismissed: false}))}
    onMouseLeave={() => setState(value => ({...value, hover: false}))}
    onFocus={() => setState(value => ({...value, focus: true, dismissed: false}))}
    onBlur={() => setState(value => ({...value, focus: false}))}
    onKeyDown={event => {if (event.key === 'Escape') setState(value => ({...value, dismissed: true}))}}>
    {cloneElement(children, {'aria-describedby': id})}
    <span id={id} role="tooltip" className={open
      ? 'absolute bottom-full left-1/2 z-30 mb-2 w-64 -translate-x-1/2 rounded-lg bg-[#24292f] px-3 py-2 text-xs font-normal text-white shadow-lg'
      : 'sr-only'}>{content}</span>
  </span>
}
