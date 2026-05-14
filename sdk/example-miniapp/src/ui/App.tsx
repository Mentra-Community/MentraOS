import {HashRouter, Navigate, Route, Routes} from "react-router-dom"

import CaptionsPage from "./pages/CaptionsPage"
import ComingSoonPage from "./pages/tester/ComingSoonPage"
import DisplayPage from "./pages/tester/DisplayPage"
import GlassesPage from "./pages/tester/GlassesPage"
import ImuPage from "./pages/tester/ImuPage"
import InputPage from "./pages/tester/InputPage"
import LedPage from "./pages/tester/LedPage"
import LocationPage from "./pages/tester/LocationPage"
import MicrophonePage from "./pages/tester/MicrophonePage"
import PermissionsPage from "./pages/tester/PermissionsPage"
import PhonePage from "./pages/tester/PhonePage"
import SpeakerPage from "./pages/tester/SpeakerPage"
import StoragePage from "./pages/tester/StoragePage"
import SystemPage from "./pages/tester/SystemPage"
import TesterMenu from "./pages/tester/TesterMenu"
import TranscriptionPage from "./pages/tester/TranscriptionPage"
import TranslationPage from "./pages/tester/TranslationPage"

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<CaptionsPage />} />
        <Route path="/tester" element={<TesterMenu />} />
        <Route path="/tester/display" element={<DisplayPage />} />
        <Route path="/tester/speaker" element={<SpeakerPage />} />
        <Route path="/tester/mic" element={<MicrophonePage />} />
        <Route path="/tester/transcription" element={<TranscriptionPage />} />
        <Route path="/tester/translation" element={<TranslationPage />} />
        <Route path="/tester/input" element={<InputPage />} />
        <Route path="/tester/location" element={<LocationPage />} />
        <Route path="/tester/imu" element={<ImuPage />} />
        <Route path="/tester/glasses" element={<GlassesPage />} />
        <Route path="/tester/phone" element={<PhonePage />} />
        <Route path="/tester/system" element={<SystemPage />} />
        <Route path="/tester/led" element={<LedPage />} />
        <Route path="/tester/storage" element={<StoragePage />} />
        <Route path="/tester/permissions" element={<PermissionsPage />} />
        <Route path="/tester/coming-soon" element={<ComingSoonPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  )
}
