import { isIP } from 'node:net';

const DEFAULT_ALLOWED_HOSTS = ['perplexity.ai'];
const MAX_URL_LEN = 2048;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function getAllowedHosts() {
  const configured = (process.env.ALLOWED_SOURCE_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  return new Set([...DEFAULT_ALLOWED_HOSTS, ...configured]);
}

function isAllowedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const allowedHosts = getAllowedHosts();

  for (const allowed of allowedHosts) {
    if (host === allowed || host.endsWith(`.${allowed}`)) {
      return true;
    }
  }

  return false;
}

/**
 * Validate and normalize a source URL.
 *
 * Rules:
 * - HTTPS only
 * - no login/password inside URL
 * - no direct IP addresses or local hostnames
 * - only explicitly configured source domains
 */
export function validateArticleUrl(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'url must be a string' };
  }

  const value = raw.trim();

  if (!value) return { ok: false, error: 'url is required' };
  if (value.length > MAX_URL_LEN) {
    return { ok: false, error: 'url too long' };
  }
  if (CONTROL_CHARS.test(value)) {
    return { ok: false, error: 'url contains control characters' };
  }

  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only HTTPS URLs are accepted' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Credentials inside URLs are not accepted' };
  }

  if (parsed.port && parsed.port !== '443') {
    return { ok: false, error: 'Only the standard HTTPS port is accepted' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    isIP(hostname)
  ) {
    return { ok: false, error: 'Local hosts and direct IP addresses are not accepted' };
  }

  if (!isAllowedHostname(hostname)) {
    return {
      ok: false,
      error: `Source domain is not allowed: ${hostname}`,
    };
  }

  return { ok: true, href: parsed.href };
}