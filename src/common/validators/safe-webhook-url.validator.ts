import { registerDecorator, ValidationOptions } from 'class-validator';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '169.254.169.254', // cloud metadata endpoint (AWS/GCP/Azure)
  '::1',
]);

function isBlockedIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 10 || // private
    a === 127 || // loopback
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 169 && b === 254) || // link-local / metadata
    a === 0 || // "this network" (0.0.0.0)
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
  );
}

/**
 * `URL.hostname` keeps the brackets around IPv6 literals (`[::1]`), so they
 * are stripped before comparing. Blocks loopback, unspecified, unique-local
 * (fc00::/7), link-local (fe80::/10) and IPv4-mapped (::ffff:a.b.c.d) forms.
 */
function isBlockedIpv6(hostname: string): boolean {
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) return false;
  const addr = hostname.slice(1, -1);
  if (addr === '::1' || addr === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(addr)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(addr)) return true;
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]);
  // Hex form of an IPv4-mapped address, e.g. ::ffff:7f00:1
  const hex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isBlockedIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

export function IsSafeWebhookUrl(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isSafeWebhookUrl',
      target: object.constructor,
      propertyName,
      options: {
        message:
          `${propertyName} must not target an internal, loopback, ` +
          'link-local, or cloud-metadata address',
        ...options,
      },
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          try {
            const hostname = new URL(value).hostname.toLowerCase();
            if (BLOCKED_HOSTNAMES.has(hostname)) return false;
            if (hostname.endsWith('.localhost') || hostname.endsWith('.internal')) {
              return false;
            }
            return !isBlockedIpv4(hostname) && !isBlockedIpv6(hostname);
          } catch {
            return false;
          }
        },
      },
    });
  };
}
