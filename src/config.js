export function resolveApiConfiguration(env = {}) {
  const baseUrl = (env.VITE_API_BASE_URL ?? env.VITE_API_URL ?? (env.PROD ? '' : '/api')).trim().replace(/\/+$/, '');
  if (!env.PROD) return { baseUrl, error: null };

  const error = 'Production requires VITE_API_BASE_URL to be a public HTTPS backend URL. Configure it in the hosting environment and rebuild.';
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      url.username || url.password || url.search || url.hash ||
      host === 'localhost' || host.endsWith('.localhost') ||
      host === '[::1]' || host === '0.0.0.0' || host.startsWith('127.')
    ) {
      return { baseUrl, error };
    }
  } catch {
    return { baseUrl, error };
  }
  return { baseUrl, error: null };
}
