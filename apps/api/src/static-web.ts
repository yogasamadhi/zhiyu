import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface StaticWebOptions {
  readonly roots?: readonly string[];
}

/** Registers the packaged Web UI without intercepting operational or API paths. */
export async function registerStaticWeb(
  app: FastifyInstance,
  options: StaticWebOptions = {},
): Promise<string | null> {
  const roots = options.roots ?? staticWebRoots();
  const webRoot = await firstWebRoot(roots);
  if (!webRoot) return null;
  const indexPath = join(webRoot, 'index.html');

  const serve = async (request: FastifyRequest, reply: FastifyReply) => {
    const pathname = requestPathname(request);
    if (pathname === null) return notFound(request, reply);
    if (reservedPath(pathname)) return notFound(request, reply);
    const requested = pathname === '/' ? indexPath : safeResolve(webRoot, pathname);
    if (requested) {
      const file = await safeFile(webRoot, requested);
      if (file) return sendFile(reply, file.path, file.size, pathname === '/');
    }
    if (extname(pathname)) return notFound(request, reply);
    const index = await safeFile(webRoot, indexPath);
    return index ? sendFile(reply, index.path, index.size, true) : notFound(request, reply);
  };

  app.get('/', serve);
  app.get('/*', serve);
  return webRoot;
}

export function staticWebRoots(): string[] {
  return [
    ...(process.env.ZHIYUN_WEB_ROOT ? [resolve(process.env.ZHIYUN_WEB_ROOT)] : []),
    join(dirname(process.execPath), 'web'),
    resolve(import.meta.dirname, '../../web/dist'),
    resolve(process.cwd(), 'apps/web/dist'),
    resolve(process.cwd(), 'web'),
  ];
}

async function firstWebRoot(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of [...new Set(candidates)]) {
    const root = await realpath(candidate).catch(() => null);
    if (!root) continue;
    const index = await stat(join(root, 'index.html')).catch(() => null);
    if (index?.isFile()) return root;
  }
  return null;
}

function requestPathname(request: FastifyRequest): string | null {
  try {
    return decodeURIComponent(new URL(request.url, 'http://zhiyun.invalid').pathname);
  } catch {
    return null;
  }
}

function reservedPath(pathname: string): boolean {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/health' ||
    pathname.startsWith('/health/') ||
    pathname === '/ready' ||
    pathname.startsWith('/ready/')
  );
}

function safeResolve(root: string, pathname: string): string | null {
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  const segments = pathname.split('/');
  if (segments.includes('..')) return null;
  const candidate = resolve(root, `.${pathname}`);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

async function safeFile(
  root: string,
  candidate: string,
): Promise<{ path: string; size: number } | null> {
  const path = await realpath(candidate).catch(() => null);
  if (!path || (path !== root && !path.startsWith(`${root}${sep}`))) return null;
  const metadata = await stat(path).catch(() => null);
  return metadata?.isFile() ? { path, size: metadata.size } : null;
}

function sendFile(reply: FastifyReply, path: string, size: number, index: boolean) {
  const extension = extname(path).toLowerCase();
  reply
    .type(contentTypes[extension] ?? 'application/octet-stream')
    .header('content-length', String(size))
    .header(
      'cache-control',
      index
        ? 'no-cache, no-store, must-revalidate'
        : /[.-][a-f\d]{8,}[.-]/iu.test(path)
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600',
    );
  return reply.send(createReadStream(path));
}

function notFound(request: FastifyRequest, reply: FastifyReply) {
  return reply
    .code(404)
    .type('application/problem+json')
    .send({
      type: 'https://zhiyun.dev/problems/not-found',
      title: 'NOT_FOUND',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'Route not found',
      instance: request.url.split('?')[0],
      traceId: request.id,
    });
}

const contentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
