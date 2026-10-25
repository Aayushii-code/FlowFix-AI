/** Local development BFF. Never forward auth secrets or arbitrary URLs to clients.
 * WARNING: before public deployment put auth, domain allowlists & rate limits on both services.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const allowed = /^(?:health|capabilities|check-types|reason-codes|scenarios|audit|connectors|contracts(?:\/compile|\/[\w-]+(?:\/revisions|\/executions)?)?|executions(?:\/[\w-]+(?:\/cancel|\/verify|\/report|\/evidence|\/root-cause)?)?|assurance\/ecommerce(?:\/rules|\/verify)?|cross-system\/verify)$/;

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const endpoint = path.join('/');
  if (!allowed.test(endpoint)) return Response.json({ error: 'Route not permitted' }, { status: 404 });
  const base = (process.env.FLOWFIX_BACKEND_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
  let origin: URL;
  try { origin = new URL(base); } catch { return Response.json({ error: 'FLOWFIX_BACKEND_URL is invalid' }, { status: 500 }); }
  if (!['http:', 'https:'].includes(origin.protocol)) return Response.json({ error: 'Backend URL must be HTTP(S)' }, { status: 500 });
  const source = new URL(request.url);
  const target = `${base}/api/${endpoint}${source.search}`;
  const options: RequestInit = { method: request.method, cache: 'no-store', signal: request.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } };
  if (!['GET','HEAD'].includes(request.method)) options.body = await request.text();
  try {
    const response = await fetch(target, options);
    const payload = await response.text();
    return new Response(payload, {
      status: response.status,
      headers: { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch { return Response.json({ error: 'Backend not reachable. Check server port and FLOWFIX_BACKEND_URL.' }, { status: 502 }); }
}
export { forward as GET, forward as POST, forward as PUT, forward as DELETE };
