import {useId, useRef, type ReactNode} from 'react';
import {SYSTEM_HEALTH_TABS, type SystemHealthTab} from '../lib/system-health-links';

export function SystemHealthTabs({selected, onSelect, children}: {
  selected: SystemHealthTab; onSelect: (tab: SystemHealthTab) => void; children: ReactNode;
}) {
  const id = useId(), buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return <div className="space-y-5">
    <div role="tablist" aria-label="System health sections" className="flex overflow-x-auto gap-1 border-b border-[#e0e4de]">
      {SYSTEM_HEALTH_TABS.map((tab, index) => <button key={tab.id} ref={button => {buttons.current[index] = button;}}
        id={`${id}-tab-${tab.id}`} role="tab" aria-selected={selected === tab.id} aria-controls={`${id}-panel-${tab.id}`}
        tabIndex={selected === tab.id ? 0 : -1}
        className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium ${selected === tab.id ? 'border-[#111217] text-[#111217]' : 'border-transparent text-[#747780] hover:text-[#14151b]'}`}
        onClick={() => onSelect(tab.id)} onKeyDown={event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % SYSTEM_HEALTH_TABS.length
            : event.key === 'ArrowLeft' ? (index + SYSTEM_HEALTH_TABS.length - 1) % SYSTEM_HEALTH_TABS.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? SYSTEM_HEALTH_TABS.length - 1 : null;
          if (next !== null) {event.preventDefault(); onSelect(SYSTEM_HEALTH_TABS[next]!.id); buttons.current[next]?.focus();}
        }}>{tab.label}</button>)}
    </div>
    {SYSTEM_HEALTH_TABS.map(tab => <div key={tab.id} id={`${id}-panel-${tab.id}`} role="tabpanel"
      aria-labelledby={`${id}-tab-${tab.id}`} hidden={selected !== tab.id} className="space-y-5">
      {selected === tab.id ? children : null}
    </div>)}
  </div>;
}
