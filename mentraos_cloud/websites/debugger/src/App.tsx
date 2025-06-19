import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Debugger } from './pages/debugger/Debugger';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/debugger" element={<Debugger />} />
        <Route path="/" element={<Navigate to="/debugger" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
