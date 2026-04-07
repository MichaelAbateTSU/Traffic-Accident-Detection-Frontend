import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatKeyLabel, formatPercent } from '../../utils/formatters.js';
import styles from './Charts.module.css';

export default function DetectionSignalsChart({ signalValues }) {
  const entries = signalValues?.entries ?? [];
  if (!entries.length) return null;

  const chartData = entries.map((entry) => ({
    name: formatKeyLabel(entry.key),
    value: entry.value,
  }));

  return (
    <section className={styles.chartWrap} aria-label="Signal values">
      <h3 className={styles.title}>Detection Signals</h3>
      <p className={styles.description}>Relative influence of model signal features for the latest detected event.</p>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" />
          <YAxis domain={[0, 1]} />
          <Tooltip
            formatter={(value) => formatPercent(value, 1)}
            contentStyle={{ background: '#101828', border: '1px solid #263149', borderRadius: '8px' }}
            labelStyle={{ color: '#e6edf3' }}
          />
          <Bar dataKey="value" fill="#86efac" />
        </BarChart>
      </ResponsiveContainer>
    </section>
  );
}
