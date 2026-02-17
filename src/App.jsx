import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Navbar    from './components/Navbar/Navbar.jsx';
import Dashboard from './pages/Dashboard/Dashboard.jsx';
import LiveFeed  from './pages/LiveFeed/LiveFeed.jsx';
import Incidents from './pages/Incidents/Incidents.jsx';
import Settings  from './pages/Settings/Settings.jsx';
import styles    from './App.module.css';

export default function App() {
  return (
    <BrowserRouter>
      <div className={styles.layout}>
        <Navbar />
        <div className={styles.content}>
          <Routes>
            <Route path="/"          element={<Dashboard />} />
            <Route path="/live"      element={<LiveFeed />}  />
            <Route path="/incidents" element={<Incidents />} />
            <Route path="/settings"  element={<Settings />}  />
            {/* Fallback — redirect unknown routes to dashboard */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}
