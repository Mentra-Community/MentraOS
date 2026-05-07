export type SaveAs = "home" | "work" | "favorite" | "custom"

type Props = {
  value: SaveAs
  onChange: (type: SaveAs) => void
}

export function SaveAsGrid({value, onChange}: Props) {
  return (
    <div className="mb-5">
      <div className="pb-2.5 px-1">
        <div className="tracking-[0.16em] uppercase font-sans font-semibold text-[#0000008C] text-[11px]/3.5">Save as</div>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {(["home", "work", "favorite", "custom"] as const).map((type) => {
          const selected = value === type
          return (
            <button
              key={type}
              type="button"
              onClick={() => onChange(type)}
              className={`aspect-square flex flex-col items-center justify-center rounded-2xl gap-2 p-3 ${selected ? "[box-shadow:#1A1A1A_0px_0px_0px_2px_inset] bg-[#0000000A]" : "[backdrop-filter:blur(20px)] [box-shadow:#00000014_0px_0px_0px_1px_inset] bg-[#FFFFFFA6]"}`}>
              <div className={`flex items-center justify-center rounded-2xl shrink-0 size-8 ${selected ? "bg-[#1A1A1A]" : "bg-[#0000000F]"}`}>
                <SaveAsIcon type={type} selected={selected} />
              </div>
              <div className={`tracking-[-0.005em] font-sans text-xs/4 capitalize ${selected ? "font-semibold text-[#1A1A1A]" : "font-medium text-[#000000D9]"}`}>
                {type}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SaveAsIcon({type, selected}: {type: SaveAs; selected: boolean}) {
  const fill = selected ? "#FFFFFF" : "#000000D9"
  if (type === "home") return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M3 12 L12 4 L21 12 L21 20 H14 V14 H10 V20 H3 Z" fill={fill} />
    </svg>
  )
  if (type === "work") return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <rect x="3" y="8" width="18" height="13" rx="1.5" fill={fill} />
      <path d="M9 8 V5 H15 V8" stroke={fill} strokeWidth="2" fill="none" />
    </svg>
  )
  if (type === "favorite") return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M12 21S3 14 3 8.5 6 2 9 2c2 0 3 1 3 3 0-2 1-3 3-3 3 0 6 2 6 6.5S12 21 12 21z" fill={fill} />
    </svg>
  )
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M12 2C7.58 2 4 5.58 4 10c0 6 8 12 8 12s8-6 8-12C20 5.58 16.42 2 12 2z" fill={fill} />
      <circle cx="12" cy="10" r="3" fill={selected ? "#1A1A1A" : "#FFFFFF"} />
    </svg>
  )
}
