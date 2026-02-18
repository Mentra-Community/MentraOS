import {createContext, useContext, useState} from "react"

interface ProfileDropdownContextType {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  toggleDropdown: () => void
}

const ProfileDropdownContext = createContext<ProfileDropdownContextType | undefined>(undefined)

export const ProfileDropdownProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const [isOpen, setIsOpen] = useState(false)

  const toggleDropdown = () => {
    setIsOpen((prev) => !prev)
  }

  return (
    <ProfileDropdownContext.Provider value={{isOpen, setIsOpen, toggleDropdown}}>
      {children}
    </ProfileDropdownContext.Provider>
  )
}

export const useProfileDropdown = () => {
  const context = useContext(ProfileDropdownContext)
  if (context === undefined) {
    throw new Error("useProfileDropdown must be used within a ProfileDropdownProvider")
  }
  return context
}
