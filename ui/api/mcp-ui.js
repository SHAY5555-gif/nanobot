/**
 * JSON-RPC shim for the Nanobot UI that expects POST /mcp/ui.
 * Internally bridges to our existing /api/mcp endpoint (Stripe MCP over stdio)
 * which accepts a simple `{ action, name, arguments }` schema.
 *
 * Supported methods:
 *  - initialize
 *  - tools/list           -> bridges to action=tools/list
 *  - tools/call           -> bridges to action=tools/call
 *  - list_agents          -> returns a stub agent list (UI needs at least one agent)
 *  - list_chats           -> returns an empty chat list
 *  - create_chat          -> returns a generated chat id
 *  - update_chat, delete_chat -> no-op ACKs
 *  - prompts/list         -> returns empty prompts
 */
function allowCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function rpcOk(res, id, result) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function rpcErr(res, id, code, message) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
}

export default async function handler(req, res) {
  allowCORS(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'Method Not Allowed. Use POST.' }));
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `https://${host}`;
  const upstreamUrl = new URL('/api/mcp', base);

  const body = await readJson(req);
  const id = body.id ?? null;
  const method = body.method || 'initialize';
  const params = body.params || {};

  try {
    // Bridge helpers
    const postUpstream = async (payload) => {
      const resp = await fetch(upstreamUrl.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const text = await resp.text();
      // Try JSON first
      try {
        return JSON.parse(text);
      } catch {
        return { upstreamText: text, status: resp.status };
      }
    };

    if (method === 'initialize') {
      return rpcOk(res, id, { ok: true });
    }

    if (method === 'tools/list') {
      const upstream = await postUpstream({ action: 'tools/list' });
      // upstream shape: { action, result, logs? }
      return rpcOk(res, id, upstream.result ?? upstream);
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      if (!name) return rpcErr(res, id, -32602, "Missing 'name' for tools/call");
      const upstream = await postUpstream({ action: 'tools/call', name, arguments: args });
      return rpcOk(res, id, upstream.result ?? upstream);
    }

    // Minimal stubs so the UI can bootstrap without a full Nanobot backend
    if (method === 'list_agents') {
      return rpcOk(res, id, {
        agents: [
          {
            id: 'stripe',
            title: 'Stripe MCP',
            description: 'Demo MCP via @stripe/mcp',
            starterMessages: [
              'List products',
              'Create a product named "Premium Plan"',
              'Show me the latest prices'
            ]
          }
        ]
      });
    }

    if (method === 'list_chats') {
      return rpcOk(res, id, { chats: [] });
    }

    if (method === 'create_chat') {
      const chatId = Math.random().toString(36).slice(2);
      return rpcOk(res, id, { id: chatId });
    }

    if (method === 'update_chat' || method === 'delete_chat') {
      return rpcOk(res, id, { ok: true });
    }

    if (method === 'prompts/list') {
      return rpcOk(res, id, { prompts: [] });
    }

    // Fallback: method not found
    return rpcErr(res, id, -32601, `Method not found: ${method}`);
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: 'Unhandled error', details: String(e) }));
  }
}
