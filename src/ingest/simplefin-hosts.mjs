// SimpleFIN egress allowlist (FATHOM_SIMPLEFIN_ALLOWED_HOSTS), kept apart from simplefin.mjs so
// src/config.mjs stays free of the ingest pipeline.

export const DEFAULT_HOSTS = Object.freeze(['bridge.simplefin.org', 'beta-bridge.simplefin.org']);
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// Comma separated host names (no scheme, port or path). Blank is the defaults; anything malformed
// is null, which the config treats as an error.
export function parseAllowedHosts(raw) {
  if (raw == null || String(raw).trim() === '') return [...DEFAULT_HOSTS];
  const hosts = String(raw).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!hosts.length || hosts.some((h) => !HOST.test(h))) return null;
  return hosts;
}
