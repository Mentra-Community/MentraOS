import {useId, useRef, useState, type ReactNode} from "react";
import {NativeActivityPanel, NativeDispatchPanel} from "./framework-dispatch";

const tabs = ["Test runs", "Run a routine", "Request delivery"];
export function TestRunsTabs({children}: {children: ReactNode}) {
  const [selected, setSelected] = useState(0);
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return <div className="space-y-5">
    <div role="tablist" aria-label="Test run tools" className="flex gap-2 border-b border-[#e0e4de]">
      {tabs.map((label, index) => <button key={label} ref={button => {buttons.current[index] = button;}}
        id={`${id}-tab-${index}`} role="tab" aria-selected={selected === index} aria-controls={`${id}-panel-${index}`}
        tabIndex={selected === index ? 0 : -1}
        className={`border-b-2 px-4 py-3 text-sm font-semibold ${selected === index ? "border-[#16803a] text-[#16803a]" : "border-transparent text-[#68746d]"}`}
        onClick={() => setSelected(index)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next !== null) {event.preventDefault(); setSelected(next); buttons.current[next]?.focus();}
        }}>{label}</button>)}
    </div>
    {[children, <NativeDispatchPanel key="dispatch"/>, <NativeActivityPanel key="delivery"/>].map((content, index) =>
      <div key={index} id={`${id}-panel-${index}`} role="tabpanel" aria-labelledby={`${id}-tab-${index}`} hidden={selected !== index} className="space-y-5">{content}</div>)}
  </div>;
}
