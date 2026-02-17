import { useState, useEffect } from 'react';
import AlertBanner from '../../components/AlertBanner/AlertBanner.jsx';
import styles from './Settings.module.css';

const DEFAULTS = {
  apiBaseUrl:     'http://localhost:8000',
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
            Configure how the frontend connects to the backend detection service.
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
              value={form.apiBaseUrl}
              onChange={handleChange}
              placeholder="http://localhost:8000"
            />
            <span className={styles.hint}>
              The root URL of your YOLO detection backend. Requests will be proxied in development.
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
              Alert Confidence Threshold ({(Number(form.alertThreshold) * 100).toFixed(0)}%)
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
              <span>50%</span>
              <span>100%</span>
            </div>
            <span className={styles.hint}>
              Only incidents with a YOLO confidence above this threshold will trigger alerts.
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
