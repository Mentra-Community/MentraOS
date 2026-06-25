import {HashRouter, Navigate, Route, Routes} from "react-router-dom"

import CameraSettingsScreen from "./pages/CameraSettingsScreen"
import DetailScreen from "./pages/DetailScreen"
import GridScreen from "./pages/GridScreen"
import SettingsScreen from "./pages/SettingsScreen"

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<GridScreen />} />
        <Route path="/photo/:index" element={<DetailScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
        <Route path="/settings/camera" element={<CameraSettingsScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  )
}
