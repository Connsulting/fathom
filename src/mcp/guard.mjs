// DNS rebinding guards for /mcp and every /api route. A browser page on a rebound name reaches this server with its own
// name in the Host header, so only names that cannot be rebound (IP literals, localhost) and names
// the operator configured are accepted. A browser also sends Origin, which must match the Host.

import { isIPv4, isIPv6 } from 'node:net';

// { hostname, port } of a Host header value (port '' when absent), or null when malformed.
function parseHost(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(v);
  if (v6) return isIPv6(v6[1]) ? { hostname: `[${v6[1]}]`, port: v6[2] || '', ip: true } : null;
  const m = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/.exec(v);
  if (!m) return null;
  return { hostname: m[1], port: m[2] || '', ip: isIPv4(m[1]) };
}

const defaultPort = protocol => (protocol === 'https:' ? '443' : '80');

export function isAllowedHost(hostHeader, config = {}) {
  const h = parseHost(hostHeader);
  if (!h) return false;
  if (h.ip) return true;
  if (h.hostname === 'localhost' || h.hostname.endsWith('.localhost')) return true;
  if (config.publicUrl) {
    const u = new URL(config.publicUrl);
    if (u.hostname.toLowerCase() === h.hostname && (h.port === '' || h.port === (u.port || defaultPort(u.protocol)))) return true;
  }
  for (const entry of config.allowedHosts || []) {
    const e = parseHost(entry);
    if (!e || e.hostname !== h.hostname) continue;
    if (e.port === '' || e.port === h.port) return true;
  }
  return false;
}

// True when there is no Origin, or it is an http(s) origin for the same host as the Host header.
export function isAllowedOrigin(originHeader, hostHeader) {
  if (originHeader === undefined) return true;
  try {
    const o = new URL(originHeader);
    const host = new URL(`http://${hostHeader}`).host;
    return (o.protocol === 'http:' || o.protocol === 'https:') && o.host === host;
  } catch {
    return false;
  }
}
