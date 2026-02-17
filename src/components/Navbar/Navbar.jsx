import { NavLink } from 'react-router-dom';
import styles from './Navbar.module.css';

const NAV_LINKS = [
  { to: '/',          label: 'Dashboard' },
  { to: '/live',      label: 'Live Feed'  },
  { to: '/incidents', label: 'Incidents'  },
  { to: '/settings',  label: 'Settings'   },
];

export default function Navbar() {
  return (
    <header className={styles.header}>
      <div className={styles.logo}>
        <svg width="28" height="28" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect width="32" height="32" rx="6" fill="#1a2236"/>
          <path d="M6 22L10 14h12l4 8H6z" fill="#ef4444" opacity="0.9"/>
          <circle cx="11" cy="22" r="2" fill="#94a3b8"/>
          <circle cx="21" cy="22" r="2" fill="#94a3b8"/>
          <path d="M16 8 L20 14 H12 Z" fill="#f59e0b"/>
        </svg>
        <span className={styles.logoText}>AccidentWatch</span>
      </div>

      <nav className={styles.nav} aria-label="Main navigation">
        {NAV_LINKS.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              [styles.navLink, isActive ? styles.active : ''].join(' ')
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>

      <div className={styles.status}>
        <span className={styles.statusDot} aria-hidden="true" />
        <span className={styles.statusLabel}>System Active</span>
      </div>
    </header>
  );
}
