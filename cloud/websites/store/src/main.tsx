import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
// import AppStoreDesign from './pages/AppStoreDesign'

// Add type definition for window object
declare global {
  interface Window {
    setSupabaseToken: (token: string) => void;
    setCoreToken: (token: string) => void;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {/* <AppStoreDesign /> */}
  </StrictMode> as any
)
