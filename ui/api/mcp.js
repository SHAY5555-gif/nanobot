/**
 * Proxy MCP endpoint for Nanobot UI.
 * Forwards requests to an upstream MCP HTTP endpoint so we don't need provider secrets here.
 *
 * Env:
 *  - UPSTREAM_MCP_URL (optional): default is https://vercel-stdio-mcp.vercel.app/api/mcp
 *
 * Usage:
 *  POST /api/mcp
 *  { "action": "tools/list" } or { "action": "tools/call", "name": "...", "arguments": {...} }
 */
const UPSTREAM_DEFAULT = 'https://vercel-stdio-mcp.vercel.app/api/mcp';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (!raw) return {};
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return { _raw: raw }; }
  }
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    return Object.fromEntries(params.entries());
  }
  return { _raw: raw };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method Not Allowed. Use POST.' }));
  }

  const upstream = process.env.UPSTREAM_MCP_URL || UPSTREAM_DEFAULT;

  // Parse incoming body (supporting both pre-parsed and raw)
  let body = {};
  try {
    body = typeof req.body === 'object' && req.body !== null ? req.body : await readBody(req);
  } catch (e) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Invalid JSON body', details: String(e) }));
  }

  try {
    const resp = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });

    // Try to forward JSON exactly; fallback to text passthrough
    const text = await resp.text();
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    res.statusCode = resp.status;
    if (ct.includes('application/json')) {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      return res.end(text);
    }
    // Non-JSON from upstream; wrap as JSON for consistency
    res.setHeader('content-type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ upstreamText: text }));
  } catch (err) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: 'Bad Gateway', details: String(err) }));
  }
}
