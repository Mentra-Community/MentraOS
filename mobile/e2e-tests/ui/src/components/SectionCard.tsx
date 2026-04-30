import type {PropsWithChildren, ReactNode} from "react"

interface SectionCardProps extends PropsWithChildren {
  title: string
  subtitle?: ReactNode
}

export function SectionCard({title, subtitle, children}: SectionCardProps) {
  return (
    <section className="section-card">
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  )
}
