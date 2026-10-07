import {useId, useRef, useState, type ReactNode} from "react";
import {NativeActivityPanel, NativeDispatchPanel} from "./framework-dispatch";

const tabs = ["Test runs", "Run a routine", "Request delivery"];
export function TestRunsTabs({children}: {children: ReactNode}) {
  const [selected, setSelected] = useState(0);
  const id = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return <div className="space-y-5">
    <div role="tablist" aria-label="Test run tools" className="flex overflow-x-auto gap-1 border-b border-[#e0e4de]">
      {tabs.map((label, index) => <button key={label} ref={button => {buttons.current[index] = button;}}
        id={`${id}-tab-${index}`} role="tab" aria-selected={selected === index} aria-controls={`${id}-panel-${index}`}
        tabIndex={selected === index ? 0 : -1}
        className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium ${selected === index ? "border-[#111217] text-[#111217]" : "border-transparent text-[#747780] hover:text-[#14151b]"}`}
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
