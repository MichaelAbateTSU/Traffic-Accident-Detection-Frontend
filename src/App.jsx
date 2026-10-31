import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useState } from 'react';
import { API_CONFIGURATION, setOperatorToken } from './services/api.js';
import OperatorAccess from './components/OperatorAccess/OperatorAccess.jsx';
import Navbar    from './components/Navbar/Navbar.jsx';
import Dashboard from './pages/Dashboard/Dashboard.jsx';
import LiveFeed  from './pages/LiveFeed/LiveFeed.jsx';
import CameraView from './pages/CameraView/CameraView.jsx';
import Incidents from './pages/Incidents/Incidents.jsx';
import Settings  from './pages/Settings/Settings.jsx';
import styles    from './App.module.css';

export default function App() {
  const requiresAuth = import.meta.env.PROD || import.meta.env.VITE_REQUIRE_AUTH === 'true';
  const [authenticated, setAuthenticated] = useState(false);
  if (API_CONFIGURATION.error) {
    return (
      <main role="alert">
        <h1>{API_CONFIGURATION.baseUrl ? 'Deployment configuration error' : 'Backend not configured'}</h1>
        {!API_CONFIGURATION.baseUrl && (
          <p>The frontend is hosted, but the detection service is not connected. Monitoring, detection, and operator access are unavailable.</p>
        )}
        <p>{API_CONFIGURATION.error}</p>
      </main>
    );
  }

  if (requiresAuth && !authenticated) {
    return <OperatorAccess onAuthenticated={() => setAuthenticated(true)} />;
  }

  const Router = import.meta.env.VITE_ROUTER_MODE === 'hash' ? HashRouter : BrowserRouter;
  return (
    <Router basename={import.meta.env.VITE_ROUTER_MODE === 'hash' ? undefined : import.meta.env.BASE_URL}>
      <div className={styles.layout}>
        <Navbar />
        <div className={styles.content}>
          {requiresAuth && (
            <button type="button" onClick={() => {
              setOperatorToken('');
              setAuthenticated(false);
            }}>
              Sign out
            </button>
          )}
          <Routes>
            <Route path="/"          element={<Dashboard />} />
            <Route path="/live"      element={<LiveFeed />}  />
            <Route path="/camera/:id" element={<CameraView />} />
            <Route path="/incidents" element={<Incidents />} />
            <Route path="/settings"  element={<Settings />}  />
            {/* Fallback — redirect unknown routes to dashboard */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
    </Router>
  );
}
