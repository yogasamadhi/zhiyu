import type { NextRequest } from 'next/server';
export const dynamic = 'force-dynamic';
async function proxy(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  if (path[0] === 'admin') return new Response('Not found', { status: 404 });
  const base = process.env.CLOUD_SERVER_URL ?? 'http://127.0.0.1:3200';
  const url = new URL(`/api/cloud/v1/${path.map(encodeURIComponent).join('/')}`, base);
  url.search = request.nextUrl.search;
  const headers = new Headers();
  for (const name of ['content-type', 'cookie', 'origin', 'x-csrf-token', 'accept']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const upstream = await fetch(url, {
      method: request.method,
      headers,
      ...(request.method === 'GET' ? {} : { body: await request.arrayBuffer() }),
      cache: 'no-store',
      redirect: 'manual',
      signal: request.signal,
    });
    const output = new Headers();
    for (const name of ['content-type', 'set-cookie']) {
      const value = upstream.headers.get(name);
      if (value) output.set(name, value);
    }
    output.set('cache-control', 'private, no-store');
    output.set('vary', 'Cookie');
    return new Response(upstream.body, { status: upstream.status, headers: output });
  } catch {
    return Response.json(
      { error: { code: 'CLOUD_UNAVAILABLE' } },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
export { proxy as GET, proxy as POST };
