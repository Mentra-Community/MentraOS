import {ReactNode, useState, cloneElement, createContext, isValidElement, useContext, useEffect} from "react"

interface DialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}

interface DialogContextValue {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const DialogContext = createContext<DialogContextValue | undefined>(undefined)

export function Dialog({open: controlledOpen, onOpenChange, children}: DialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen
  const handleOpenChange = onOpenChange || setUncontrolledOpen

  return <DialogContext.Provider value={{open, onOpenChange: handleOpenChange}}>{children}</DialogContext.Provider>
}

function useDialog() {
  const context = useContext(DialogContext)
  if (!context) {
    throw new Error("Dialog components must be used within Dialog")
  }
  return context
}

interface DialogTriggerProps {
  asChild?: boolean
  children: ReactNode
}

export function DialogTrigger({asChild, children}: DialogTriggerProps) {
  const {onOpenChange} = useDialog()

  const handleClick = () => {
    onOpenChange(true)
  }

  if (asChild && isValidElement(children)) {
    return cloneElement(children, {
      onClick: (e: MouseEvent) => {
        children.props.onClick?.(e)
        handleClick()
      },
    } as any)
  }

  return <button onClick={handleClick}>{children}</button>
}

interface DialogContentProps {
  className?: string
  children: ReactNode
}

export function DialogContent({className = "", children}: DialogContentProps) {
  const {open, onOpenChange} = useDialog()

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden"
    } else {
      document.body.style.overflow = ""
    }

    return () => {
      document.body.style.overflow = ""
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50" onClick={() => onOpenChange(false)} />

      {/* Content */}
      <div
        className={`relative bg-white rounded-lg shadow-lg p-6 w-full max-w-lg mx-4 ${className}`}
        onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}

interface DialogHeaderProps {
  className?: string
  children: ReactNode
}

export function DialogHeader({className = "", children}: DialogHeaderProps) {
  return <div className={`mb-4 ${className}`}>{children}</div>
}

interface DialogTitleProps {
  className?: string
  children: ReactNode
}

export function DialogTitle({className = "", children}: DialogTitleProps) {
  return <h2 className={`text-lg font-semibold ${className}`}>{children}</h2>
}
