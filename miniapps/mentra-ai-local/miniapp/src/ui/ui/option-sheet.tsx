import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';

/** Red Hat Display stack (matches the Settings mockup; falls back to system). */
const FONT_STACK = "'RedHatDisplay-Regular_Bold','Red_Hat_Display',system-ui,sans-serif";

export interface SheetOption<T extends string> {
  /** Stable value passed back to onSelect. */
  value: T;
  /** Primary label shown for the row. */
  label: string;
  /** Optional secondary line under the label (e.g. provider / note). */
  description?: string;
  /** Optional leading icon (e.g. a brand logo) shown to the left of the label. */
  leading?: React.ReactNode;
  /** When true, the row is dimmed and not selectable. */
  disabled?: boolean;
}

interface OptionSheetProps<T extends string> {
  /** Whether the sheet is visible. */
  open: boolean;
  /** Header title (e.g. "Model"). */
  title: string;
  /** All choices to render. */
  options: ReadonlyArray<SheetOption<T>>;
  /** The currently-selected value (gets a check + tint). */
  value: T;
  /** Called with the chosen value; the sheet closes itself after. */
  onSelect: (value: T) => void;
  /** Close without choosing (backdrop tap / drag-down / Esc). */
  onClose: () => void;
}

/** Pink check shown on the selected row. */
function CheckIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}>
      <path d="m5 12.5 4.5 4.5L19 7" fill="none" stroke="#FF5FA2" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * OptionSheet — a reusable bottom-sheet picker.
 *
 * Renders a dimmed backdrop and a frosted card that slides up from the bottom,
 * listing every option with the current one checked. Generic over the value
 * type so any setting (model, language, …) can reuse it:
 *
 *   <OptionSheet
 *     open={open} title="Model" options={MODEL_OPTIONS_AS_SHEET}
 *     value={model} onSelect={handleModelChange} onClose={() => setOpen(false)} />
 *
 * Portaled to <body> so it escapes any transformed/overflow-clipped ancestor.
 */
export default function OptionSheet<T extends string>({
  open,
  title,
  options,
  value,
  onSelect,
  onClose,
}: OptionSheetProps<T>) {
  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Claim the OS back gesture while open: push a throwaway history entry so the
  // first back-swipe / Android-back closes the SHEET (consumed by popstate)
  // instead of popping the underlying page. On a normal close (tap/select) we
  // pop that entry back off so history stays balanced.
  useEffect(() => {
    if (!open) return;
    let closedByPop = false;
    try {
      history.pushState({ sheet: true }, '');
    } catch {
      /* no-op */
    }
    const onPop = () => {
      closedByPop = true;
      onClose();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // If we closed ourselves (not via back), remove the entry we added.
      if (!closedByPop) {
        try {
          history.back();
        } catch {
          /* no-op */
        }
      }
    };
  }, [open, onClose]);

  // Prevent the page behind the sheet from scrolling while it's open. The
  // overlay itself is `touch-none` and the option list contains its own
  // overscroll, so this just stops any residual wheel/scroll-chaining on the
  // root. Styles are saved and restored exactly so nothing is left frozen after
  // close (which previously left Settings stuck at a shifted offset).
  useEffect(() => {
    if (!open) return;
    const { body } = document;
    const prevOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    // Pause any decorative background animations behind the sheet (e.g. the
    // Settings gradient). A moving blurred layer behind a fixed backdrop-blur
    // forces the blur to re-sample every frame, which makes the open feel
    // heavy. `.sheet-open` is a hook for CSS to halt those animations.
    body.classList.add('sheet-open');
    return () => {
      body.style.overflow = prevOverflow;
      body.classList.remove('sheet-open');
    };
  }, [open]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div
          key="option-sheet"
          className="fixed inset-0 z-[200] flex flex-col justify-end"
          style={{ fontFamily: FONT_STACK }}
        >
          {/* Dimmed, blurred backdrop — tap to dismiss.
              Only OPACITY is animated (GPU-composited, ~free). The blur radius
              is a FIXED value, so WebKit can cache the blurred layer instead of
              re-sampling the whole page every frame — animating `blur()` itself
              was the source of the open-lag. The fade reads almost identically
              to a growing blur but stays smooth on-device. */}
          <motion.div
            className="absolute inset-0 bg-black/30 touch-none [backdrop-filter:blur(6px)] [-webkit-backdrop-filter:blur(6px)]"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          />

          {/* Sheet — solid background, no backdrop-filter, so the translateY
              animation stays cheap and nothing recomposites at the end. */}
          <motion.div
            className="relative w-full max-w-[440px] mx-auto rounded-t-[24px] overflow-hidden bg-white border-t border-x border-solid border-black/[0.06] [box-shadow:#0B0B0F1F_0px_-8px_40px]"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 520, damping: 42, mass: 0.8 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.4 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 100 || info.velocity.y > 600) onClose();
            }}
            style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}
          >
            {/* Grab handle */}
            <div className="flex justify-center pt-2.5 pb-1">
              <div className="w-9 h-1 rounded-full bg-[#0B0B0F26]" />
            </div>

            {/* Title */}
            <div className="px-5 pt-2 pb-3">
              <div className="font-bold text-[#0B0B0F] text-[19px]/6 tracking-[-0.01em]">{title}</div>
            </div>

            {/* Options — own scroll region; contain overscroll so it never
                chains to the page behind the sheet. */}
            <div
              className="px-3 pb-3 flex flex-col gap-0.5 max-h-[60vh] overflow-y-auto"
              style={{ overscrollBehavior: 'contain', touchAction: 'pan-y' }}
            >
              {options.map((opt) => {
                const selected = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    disabled={opt.disabled}
                    onClick={() => {
                      if (opt.disabled) return;
                      onSelect(opt.value);
                      onClose();
                    }}
                    className={`flex items-center gap-3 w-full text-left rounded-[14px] px-3 py-3 transition-colors ${
                      selected ? 'bg-[#FF5FA20F]' : 'active:bg-[#0B0B0F08]'
                    } ${opt.disabled ? 'opacity-40' : ''}`}
                  >
                    {opt.leading && (
                      <div className="flex items-center justify-center w-[34px] h-[34px] shrink-0 rounded-[9px] bg-[#0B0B0F0D]">
                        {opt.leading}
                      </div>
                    )}
                    <div className="grow min-w-0">
                      <div className="font-semibold text-[#0B0B0F] text-[15px]/5 truncate">
                        {opt.label}
                      </div>
                      {opt.description && (
                        <div className="font-medium text-[#6B6B72] text-[13px]/4.5 truncate">
                          {opt.description}
                        </div>
                      )}
                    </div>
                    <div className="w-5 shrink-0 flex justify-end">{selected && <CheckIcon />}</div>
                  </button>
                );
              })}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
