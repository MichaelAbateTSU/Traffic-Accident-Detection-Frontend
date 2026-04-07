import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatPercent } from '../../utils/formatters.js';
import styles from './Charts.module.css';

export default function ConfidenceTrendChart({ events = [] }) {
  if (!events.length) return null;

  const chartData = events.map((event, index) => ({
    index: event.frameIdx ?? index,
    confidence: Number(event.confidenceScore ?? 0),
    raw: Number(event.rawScore ?? 0),
  }));

  return (
    <section className={styles.chartWrap} aria-label="Confidence trend">
      <h3 className={styles.title}>Confidence Trend</h3>
      <p className={styles.description}>Frame-by-frame confidence and raw score progression for the latest detection job.</p>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="index" />
          <YAxis domain={[0, 1]} />
          <Tooltip
            formatter={(value) => formatPercent(value, 2)}
            contentStyle={{ background: '#101828', border: '1px solid #263149', borderRadius: '8px' }}
            labelStyle={{ color: '#e6edf3' }}
          />
          <Line type="monotone" dataKey="confidence" stroke="#4cd2ff" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="raw" stroke="#ffd38a" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </section>
  );
}
