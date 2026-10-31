import { useState, useEffect } from 'react';
import AlertBanner from '../../components/AlertBanner/AlertBanner.jsx';
import { API_CONFIGURATION } from '../../services/api.js';
import styles from './Settings.module.css';

const DEFAULTS = {
  pollInterval:   5000,
  cameraIds:      'CAM-01, CAM-02, CAM-03, CAM-04',
  alertThreshold: 0.75,
  enableAlerts:   true,
};

const STORAGE_KEY = 'tad_settings';

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export default function Settings() {
  const [form,    setForm]    = useState(loadSettings);
  const [saved,   setSaved]   = useState(false);
  const [error,   setError]   = useState(null);

  // Clear the "Saved" banner after 3 seconds
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(t);
  }, [saved]);

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    setForm(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  }

  function handleSave(e) {
    e.preventDefault();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
      setSaved(true);
      setError(null);
    } catch (err) {
      setError('Failed to save settings: ' + err.message);
    }
  }

  function handleReset() {
    setForm({ ...DEFAULTS });
  }

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
        <span className={styles.subtitle}>Configure API connection and detection preferences</span>
      </div>

      {saved && (
        <AlertBanner type="info" message="Settings saved successfully." />
      )}
      {error && (
        <AlertBanner type="warning" message={error} />
      )}

      <form className={styles.form} onSubmit={handleSave} noValidate>

        {/* ── API Connection ── */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>API Connection</h2>
          <p className={styles.sectionDesc}>
            The backend connection is configured when the app is built, not by saved browser preferences.
          </p>

          <div className={styles.fieldGroup}>
            <label htmlFor="apiBaseUrl" className={styles.label}>
              Backend API Base URL
            </label>
            <input
              id="apiBaseUrl"
              name="apiBaseUrl"
              type="url"
              className={styles.input}
              value={API_CONFIGURATION.baseUrl}
              readOnly
            />
            <span className={styles.hint}>
              Set VITE_API_BASE_URL in the hosting environment and redeploy to change this URL.
              The default /api path is proxied only by the development server.
            </span>
          </div>
        </section>

        {/* ── Camera Configuration ── */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Camera Configuration</h2>

          <div className={styles.fieldGroup}>
            <label htmlFor="cameraIds" className={styles.label}>
              Camera IDs to Monitor
            </label>
            <input
              id="cameraIds"
              name="cameraIds"
              type="text"
              className={styles.input}
              value={form.cameraIds}
              onChange={handleChange}
              placeholder="CAM-01, CAM-02, CAM-03"
            />
            <span className={styles.hint}>Comma-separated list of camera identifiers.</span>
          </div>

          <div className={styles.fieldGroup}>
            <label htmlFor="pollInterval" className={styles.label}>
              Frame Poll Interval (ms)
            </label>
            <input
              id="pollInterval"
              name="pollInterval"
              type="number"
              min="500"
              max="60000"
              step="500"
              className={styles.input}
              value={form.pollInterval}
              onChange={handleChange}
            />
            <span className={styles.hint}>
              How often (in milliseconds) to fetch the latest frame from each camera. Minimum 500ms.
            </span>
          </div>
        </section>

        {/* ── Detection Preferences ── */}
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Detection Preferences</h2>

          <div className={styles.fieldGroup}>
            <label htmlFor="alertThreshold" className={styles.label}>
              Heuristic Accident Score Threshold ({Number(form.alertThreshold).toFixed(2)} on a 0-1 scale)
            </label>
            <input
              id="alertThreshold"
              name="alertThreshold"
              type="range"
              min="0.5"
              max="1"
              step="0.01"
              className={styles.range}
              value={form.alertThreshold}
              onChange={handleChange}
            />
            <div className={styles.rangeLabels}>
              <span>0.50</span>
              <span>1.00</span>
            </div>
            <span className={styles.hint}>
              Saved browser preference for the heuristic accident score, not a calibrated probability or
              YOLO object-detection confidence. This preference does not change backend scoring or detection thresholds.
            </span>
          </div>

          <div className={styles.checkboxGroup}>
            <label className={styles.checkboxLabel}>
              <input
                type="checkbox"
                name="enableAlerts"
                className={styles.checkbox}
                checked={form.enableAlerts}
                onChange={handleChange}
              />
              <span>Enable in-app alert banners for new incidents</span>
            </label>
          </div>
        </section>

        {/* ── Actions ── */}
        <div className={styles.actions}>
          <button type="submit" className={styles.btnPrimary}>
            Save Settings
          </button>
          <button type="button" className={styles.btnSecondary} onClick={handleReset}>
            Reset to Defaults
          </button>
        </div>
      </form>
    </main>
  );
}
