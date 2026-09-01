import { isIP } from 'node:net';
import {
  crawlPlanDefinitionSchema,
  taskTemplateSchema,
  type CrawlPlanDefinition,
  type TaskTemplate,
} from '@zhiyun/shared';

const PRIVATE_IPV4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const;

const SENSITIVE_NAME =
  /password|passphrase|token|secret|credential|privatekey|accesskey|apikey|authorization|cookie|storagestate/u;
const DEVELOPMENT_MARKER =
  /(?:^|[^a-z0-9])(?:dev(?:elopment)?|test)[-_ ]?fixtures?(?:$|[^a-z0-9])|(?:^|[^a-z0-9])fixtures?[-_ ]?(?:only|url|id|site)?(?:$|[^a-z0-9])|(?:^|[^a-z0-9])(?:dev|development|test|demo)[-_ ]?only(?:$|[^a-z0-9])/iu;
const PRIVATE_KEY_MATERIAL = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u;
const URL_WITH_AUTHORITY = /^[a-z][a-z\d+.-]*:\/\//iu;
const SAFE_EMPTY_SENSITIVE_PATHS = new Set([
  '$.taskDefaults.credentialBindings',
  '$.taskDefaults.requestSettings.cookies',
]);

/**
 * Validates the release catalog before Zod can strip unknown manifest fields.
 *
 * The literal-address policy intentionally matches the crawler runtime's
 * private/reserved IPv4 ranges and additionally handles IPv4-mapped IPv6.
 * Keeping this check synchronous prevents catalog loading from doing DNS I/O.
 */
export function validateTaskTemplateCatalog(catalog: readonly unknown[]): TaskTemplate[] {
  const identities = new Set<string>();
  return catalog.map((candidate, index) => {
    assertManifestSafe(candidate, `$[${index}]`, new WeakSet<object>());
    const parsed = taskTemplateSchema.parse(candidate);
    const identity = `${parsed.id}@${parsed.version}`;
    if (identities.has(identity)) throw new Error(`Duplicate Task Template ${identity}`);
    identities.add(identity);
    return parsed;
  });
}

export function instantiateTaskTemplateDefinition(
  template: TaskTemplate,
  parameters: Record<string, unknown>,
): CrawlPlanDefinition {
  const resolved = resolveTaskTemplateParameters(template, parameters);
  return crawlPlanDefinitionSchema.parse(substitute(template.ruleDefinition, resolved));
}

export function resolveTaskTemplateParameters(
  template: TaskTemplate,
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const parameter of template.parameters) {
    const value = parameters[parameter.key] ?? parameter.defaultValue;
    if (parameter.required && (value === undefined || value === null || value === '')) {
      throw new Error(`Template parameter ${parameter.key} is required`);
    }
    if (value === undefined) continue;
    if (parameter.type === 'number' && typeof value !== 'number') {
      throw new Error(`Template parameter ${parameter.key} must be a number`);
    }
    if (parameter.type === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`Template parameter ${parameter.key} must be a boolean`);
    }
    if (
      (parameter.type === 'string' || parameter.type === 'selector') &&
      typeof value !== 'string'
    ) {
      throw new Error(`Template parameter ${parameter.key} must be a string`);
    }
    resolved[parameter.key] = value;
  }
  return resolved;
}

function assertManifestSafe(value: unknown, path: string, visited: WeakSet<object>): void {
  if (typeof value === 'string') {
    assertSafeString(value, path);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (visited.has(value)) throw new Error(`Circular value in Task Template at ${path}`);
  visited.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertManifestSafe(item, `${path}[${index}]`, visited));
    visited.delete(value);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const normalizedKey = normalizeName(key);
    if (isDevelopmentMarker(key)) {
      throw new Error(`Development fixture marker is forbidden in Task Template at ${childPath}`);
    }
    if (
      isSensitiveName(normalizedKey) &&
      !(SAFE_EMPTY_SENSITIVE_PATHS.has(stripCatalogIndex(childPath)) && isEmpty(child))
    ) {
      throw new Error(`Sensitive key is forbidden in Task Template at ${childPath}`);
    }
    if (
      normalizedKey === 'key' &&
      typeof child === 'string' &&
      isSensitiveName(normalizeName(child))
    ) {
      throw new Error(`Sensitive parameter key is forbidden in Task Template at ${childPath}`);
    }
    assertManifestSafe(child, childPath, visited);
  }
  visited.delete(value);
}

function assertSafeString(value: string, path: string): void {
  if (isDevelopmentMarker(value)) {
    throw new Error(`Development fixture marker is forbidden in Task Template at ${path}`);
  }
  if (PRIVATE_KEY_MATERIAL.test(value)) {
    throw new Error(`Private key material is forbidden in Task Template at ${path}`);
  }
  if (!URL_WITH_AUTHORITY.test(value)) return;
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new Error(`Invalid URL in Task Template at ${path}`);
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error(`Only HTTP and HTTPS URLs are allowed in Task Template at ${path}`);
  }
  if (target.username || target.password) {
    throw new Error(`URL credentials are forbidden in Task Template at ${path}`);
  }
  if (
    [...target.searchParams.keys()].some((key) => isSensitiveName(normalizeName(key))) ||
    (target.hash.includes('=') &&
      [...new URLSearchParams(target.hash.slice(1)).keys()].some((key) =>
        isSensitiveName(normalizeName(key)),
      ))
  ) {
    throw new Error(`URL credential parameters are forbidden in Task Template at ${path}`);
  }
  if (unsafeTemplateHostname(target.hostname)) {
    throw new Error(
      `Private, loopback or development URL is forbidden in Task Template at ${path}`,
    );
  }
}

function unsafeTemplateHostname(input: string): boolean {
  const hostname = input
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '')
    .toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.test') ||
    hostname.endsWith('.invalid') ||
    hostname.endsWith('.example') ||
    ['example.com', 'example.net', 'example.org'].includes(hostname) ||
    hostname.split('.').some((label) => /^(?:dev|development|demo|fixtures?)(?:-|$)/u.test(label))
  ) {
    return true;
  }
  if (isIP(hostname) === 4) return privateIpv4(hostname);
  if (isIP(hostname) !== 6) return false;
  return privateIpv6(hostname);
}

function privateIpv4(address: string): boolean {
  return PRIVATE_IPV4_CIDRS.some((cidr) => inIpv4Cidr(address, cidr));
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%', 1)[0] ?? address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  const first = Number.parseInt(normalized.split(':', 1)[0] || '0', 16);
  if (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00
  ) {
    return true;
  }
  const embedded = embeddedIpv4(normalized);
  return embedded ? privateIpv4(embedded) : false;
}

function embeddedIpv4(address: string): string | null {
  if (!address.startsWith('::')) return null;
  const suffix = address.replace(/^::(?:ffff:)?/u, '');
  if (isIP(suffix) === 4) return suffix;
  const parts = suffix.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[a-f\d]{1,4}$/u.test(part))) return null;
  const high = Number.parseInt(parts[0]!, 16);
  const low = Number.parseInt(parts[1]!, 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function inIpv4Cidr(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split('/');
  if (!network) return false;
  const prefix = Number(prefixText ?? 32);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);
}

function substitute(value: unknown, parameters: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{([^}]+)\}\}/gu, (_match, key: string) => {
      const replacement = parameters[key];
      if (typeof replacement !== 'string' || !replacement.trim()) {
        throw new Error(`Template parameter ${key} is required`);
      }
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, parameters));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substitute(item, parameters)]),
    );
  }
  return value;
}

function stripCatalogIndex(path: string): string {
  return path.replace(/^\$\[\d+\]/u, '$');
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z\d]/gu, '');
}

function isSensitiveName(normalized: string): boolean {
  return SENSITIVE_NAME.test(normalized);
}

function isDevelopmentMarker(value: string): boolean {
  return DEVELOPMENT_MARKER.test(value);
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value).length === 0;
}
