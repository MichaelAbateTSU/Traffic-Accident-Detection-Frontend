import { useState } from 'react';
import { getCameraStatus, setOperatorToken } from '../../services/api.js';

export default function OperatorAccess({ onAuthenticated }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);

  async function signIn(event) {
    event.preventDefault();
    setError(null);
    setChecking(true);
    try {
      setOperatorToken(token);
      setToken('');
      await getCameraStatus();
      onAuthenticated();
    } catch (err) {
      setOperatorToken('');
      setError(`Cannot connect as operator: ${err.message}`);
    } finally {
      setChecking(false);
    }
  }

  return (
    <main>
      <h1>Operator access</h1>
      <p>Enter the backend operator token to connect. It stays in memory and is cleared on sign out or page reload.</p>
      <form onSubmit={signIn}>
        <label htmlFor="operator-token">Operator token</label>
        <input
          id="operator-token"
          type="password"
          autoComplete="off"
          required
          value={token}
          onChange={(event) => setToken(event.target.value)}
          disabled={checking}
        />
        <button type="submit" disabled={checking || !token.trim()}>
          {checking ? 'Connecting...' : 'Connect'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
