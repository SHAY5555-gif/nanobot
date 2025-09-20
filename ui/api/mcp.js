import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Vercel Serverless Function (ESM) that proxies a single MCP JSON-RPC request
 * to @stripe/mcp over STDIO per invocation.
 *
 * Request JSON body:
 * {
 *   "action": "initialize" | "tools/list" | "tools/call",
 *   // when action === "tools/call":
 *   "name": "list_products",
 *   "arguments": { "limit": 5 }
 * }
 *
 * Notes:
 * - This is stateless (one-shot) per request. Not a persistent MCP session.
 * - Requires STRIPE_SECRET_KEY (and any other provider keys) to be set on Vercel.
 */

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
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
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

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: 'Missing STRIPE_SECRET_KEY env.' }));
  }

  let body = {};
  try {
    // try req.body if vercel parsed it; otherwise read raw
    body = typeof req.body === 'object' && req.body !== null ? req.body : await readBody(req);
    if (typeof body !== 'object' || body === null) throw new Error('Invalid JSON');
  } catch (e) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Invalid JSON body', details: String(e) }));
  }

  const action = body.action || 'tools/list';
  const callName = body.name;
  const callArgs = body.arguments || {};

  // Resolve @stripe/mcp bin from local deps (preferred), else fall back to npx.
  const require = createRequire(import.meta.url);
  let mcpCmd;
  let mcpArgs;
  try {
    const mcpPkgPath = require.resolve('@stripe/mcp/package.json');
    const mcpPkg = require('@stripe/mcp/package.json');
    const mcpRoot = path.dirname(mcpPkgPath);
    let binRel;
    if (typeof mcpPkg.bin === 'string') {
      binRel = mcpPkg.bin;
    } else if (mcpPkg.bin && typeof mcpPkg.bin === 'object') {
      const first = Object.values(mcpPkg.bin)[0];
      binRel = first;
    }
    if (!binRel) throw new Error('Unable to resolve @stripe/mcp bin');
    const binAbs = path.join(mcpRoot, binRel);
    mcpCmd = process.execPath; // node
    mcpArgs = [binAbs, '--tools=all', `--api-key=${stripeKey}`];
  } catch (_e) {
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    mcpCmd = npxCmd;
    mcpArgs = ['-y', '@stripe/mcp', '--tools=all', `--api-key=${stripeKey}`];
  }

  const child = spawn(mcpCmd, mcpArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let nextId = 1;
  const pending = new Map();
  const stdoutBuffer = [];
  let stdoutChunk = '';

  function sendRPC(method, params) {
    const id = nextId++;
    const msg = { jsonrpc: '2.0', id, method, params: params || {} };
    child.stdin.write(JSON.stringify(msg) + '\n');
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timeout waiting for response to id=${id} (${method})`));
        }
      }, 20000);
    });
  }

  function complete(id, payload) {
    const p = pending.get(id);
    if (p) {
      pending.delete(id);
      p.resolve(payload);
    }
  }

  function fail(id, err) {
    const p = pending.get(id);
    if (p) {
      pending.delete(id);
      p.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  child.stdout.on('data', (buf) => {
    stdoutChunk += buf.toString('utf8');
    const parts = stdoutChunk.split(/\r?\n/);
    stdoutChunk = parts.pop() || '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      stdoutBuffer.push(trimmed);
      try {
        const obj = JSON.parse(trimmed);
        if (obj && Object.prototype.hasOwnProperty.call(obj, 'id')) {
          if (obj.error) {
            fail(obj.id, new Error(obj.error.message || 'MCP error'));
          } else {
            complete(obj.id, obj.result ?? obj);
          }
        }
      } catch {
        // Non-JSON line — ignore
      }
    }
  });

  child.stderr.on('data', () => {
    // Intentionally ignore MCP stderr logs to keep API quiet
  });

  const killChild = () => {
    try {
      child.stdin.end();
    } catch {}
    try {
      child.kill('SIGKILL');
    } catch {}
  };

  const hardTimeout = setTimeout(() => {
    killChild();
  }, 25000);

  try {
    // Initialize MCP session
    await sendRPC('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { roots: { listChanged: false }, sampling: {}, elicitation: {} },
      clientInfo: { name: 'nanobot-ui-mcp-stdio-bridge', version: '0.1.0' },
    });

    let result;
    if (action === 'initialize') {
      result = { ok: true, note: 'Initialized MCP session (one-shot)' };
    } else if (action === 'tools/list') {
      result = await sendRPC('tools/list', {});
    } else if (action === 'tools/call') {
      if (!callName) throw new Error("Missing 'name' for tools/call");
      result = await sendRPC('tools/call', {
        name: callName,
        arguments: callArgs,
        _meta: { progressToken: Math.random().toString(36).slice(2) },
      });
    } else {
      throw new Error(`Unsupported action: ${action}`);
    }

    res.statusCode = 200;
    return res.end(JSON.stringify({ action, result, logs: stdoutBuffer.slice(-50) }));
  } catch (err) {
    res.statusCode = 500;
    return res.end(
      JSON.stringify({
        error: String(err && err.message ? err.message : err),
        logs: stdoutBuffer.slice(-50),
      }),
    );
  } finally {
    clearTimeout(hardTimeout);
    killChild();
  }
}
