import { isIP } from 'node:net';
import proxyaddr from 'proxy-addr';

export function createClientAddressResolver(cidrs) {
  const ranges = cidrs.flatMap(cidr => {
    const [address, prefix] = cidr.split('/');
    if (prefix !== '0') return [cidr];
    return isIP(address) === 4 ? ['0.0.0.0/1', '128.0.0.0/1'] : ['::/1', '8000::/1'];
  });
  const trust = proxyaddr.compile(ranges);
  return req => {
    const socket = req.socket?.remoteAddress || 'unknown';
    if (!isIP(socket) || !trust(socket)) return socket;
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded !== 'string') return socket;
    const addresses = forwarded.split(',').map(address => address.trim());
    if (addresses.some(address => !isIP(address))) return socket;
    const client = proxyaddr({ socket: { remoteAddress: socket }, headers: { 'x-forwarded-for': addresses.join(', ') } }, trust);
    return isIP(client) ? client : socket;
  };
}
