interface EmptyStateProps {
  title: string
  detail: string
}

export function EmptyState({title, detail}: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      <div className="empty-detail">{detail}</div>
    </div>
  )
}
