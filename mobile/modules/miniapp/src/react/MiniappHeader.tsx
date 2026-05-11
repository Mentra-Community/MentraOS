/**
 * @fileoverview MiniappHeader — drop-in header component that aligns with
 * the host's floating capsule menu.
 *
 * The header has three slots: `left`, `title`, and `right`. Content auto-
 * respects the safe area and leaves room for the capsule menu on the far
 * top-right. Typical usage:
 *
 *   <MiniappHeader
 *     title="Live Captions"
 *     left={<BackButton onClick={goBack} />}
 *     right={<Badge>Connected</Badge>}
 *   />
 *
 * If `title` is a string it renders as a semantic <h1>. Pass a ReactNode if
 * you need custom styling. The component itself is unstyled beyond the
 * layout — use `className` or `style` for theming.
 */

import type {CSSProperties, ReactNode} from "react"

import {useCapsuleHeaderStyle, type UseCapsuleHeaderStyleOptions} from "./useCapsuleHeaderStyle"

export interface MiniappHeaderProps extends UseCapsuleHeaderStyleOptions {
  /** Title — string renders as <h1>; pass a node for custom markup. */
  title?: ReactNode
  /** Left slot, typically a back button or logo. Overrides onBack if both set. */
  left?: ReactNode
  /**
   * Shortcut: when provided, renders a back chevron in the left slot that
   * calls this handler. Ignored if `left` is explicitly set.
   */
  onBack?: () => void
  /** Right slot, typically a badge or action buttons. Sits to the left of the capsule. */
  right?: ReactNode
  /** Custom className applied to the header element. */
  className?: string
  /** Inline style overrides merged over the computed layout style. */
  style?: CSSProperties
  /**
   * When true, adds a 8px spacer <div> below the header so your next
   * content doesn't sit flush against it. Default true.
   */
  bottomSpacer?: boolean
}

function BackChevron({onBack}: {onBack: () => void}): ReactNode {
  return (
    <button
      type="button"
      onClick={onBack}
      aria-label="Back"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        marginLeft: -8,
        padding: 0,
        border: "none",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        borderRadius: 8,
      }}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M15 18l-6-6 6-6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

export function MiniappHeader({
  title,
  left,
  onBack,
  right,
  className,
  style,
  bottomSpacer = true,
  ...styleOptions
}: MiniappHeaderProps): ReactNode {
  const computedStyle = useCapsuleHeaderStyle(styleOptions)
  const resolvedLeft = left ?? (onBack ? <BackChevron onBack={onBack} /> : null)

  return (
    <>
      <header className={className} style={{...computedStyle, ...style}}>
        <div style={{display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1}}>
          {resolvedLeft}
          {typeof title === "string" ? (
            <h1
              style={{
                fontSize: 18,
                fontWeight: 600,
                lineHeight: 1,
                margin: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}>
              {title}
            </h1>
          ) : (
            title
          )}
        </div>
        {right ? (
          <div style={{display: "flex", alignItems: "center", gap: 8, flexShrink: 0}}>{right}</div>
        ) : null}
      </header>
      {bottomSpacer ? <div style={{height: 8, flexShrink: 0}} /> : null}
    </>
  )
}
