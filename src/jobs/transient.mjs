// Error classes worth one automatic retry: network, rate limit, store lock and timeout failures.
const TRANSIENT = new Set(['simplefin_network', 'simplefin_bad_response', 'email_network', 'email_rate_limited', 'store_locked', 'TimeoutError', 'AbortError']);
const TRANSIENT_RE = /timeout|network|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i;
export function isTransient(errorClass) {
  return typeof errorClass === 'string' && errorClass !== '' && (TRANSIENT.has(errorClass) || TRANSIENT_RE.test(errorClass));
}
