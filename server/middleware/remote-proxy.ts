/**
 * Remote proxy middleware — intercepts file/workspace/memory/session/token API
 * calls and routes them to vaani_core's cockpit-proxy when NERVE_REMOTE_MODE=true.
 *
 * **Additive-only**: This file does not modify any existing route files. It
 * sits as a middleware layer that, when active, short-circuits matching
 * requests before they reach the local file-system route handlers.
 *
 * The user's API key and vaani_core URL are extracted from request headers
 * (`X-Proxy-Api-Key` and `X-Proxy-Api-Url`), set by the Nerve frontend
 * from localStorage (originally injected via deep-link URL params).
 *
 * When NERVE_REMOTE_MODE is false (default), this middleware is a no-op
 * and all requests pass through to the existing local handlers unchanged.
 *
 * @module
 */

import type { Context, Next } from "hono";
import {
  isRemoteMode,
  ProxyError,
  proxyGetTree,
  proxyReadFile,
  proxyWriteFile,
  proxyRenameEntry,
  proxyMoveEntry,
  proxyTrashEntry,
  proxyReadImage,
  proxyListWorkspaceFiles,
  proxyReadWorkspaceFile,
  proxyWriteWorkspaceFile,
  proxyGetMemories,
  proxyCreateMemory,
  proxyGetMemorySection,
  proxyUpdateMemorySection,
  proxyDeleteMemory,
  proxyGetSessionModel,
  proxyGetTokenUsage,
  proxyCronList,
  proxyCronAdd,
  proxyCronUpdate,
  proxyCronRemove,
  proxyCronToggle,
  proxyCronRun,
  proxyCronGetRuns,
  type ProxyCredentials,
} from "../lib/orchestrator-client.js";

// ── Helpers ─────────────────────────────────────────────────────────

/** Extract proxy credentials from request headers. */
function extractCredentials(c: Context): ProxyCredentials | null {
  const apiKey = c.req.header("X-Proxy-Api-Key");
  const apiUrl = c.req.header("X-Proxy-Api-Url");
  if (apiKey && apiUrl) return { apiKey, apiUrl };
  return null;
}

/** Map ProxyError to appropriate HTTP response. */
function handleProxyError(c: Context, err: unknown): Response {
  if (err instanceof ProxyError) {
    return c.json({ error: err.detail }, err.status as 400);
  }
  console.error("[remote-proxy] Cockpit proxy call failed:", err);
  return c.json({ error: "Remote proxy unavailable" }, 502);
}

// ── Route matchers ──────────────────────────────────────────────────

type Handler = (c: Context, creds: ProxyCredentials) => Promise<Response>;

interface RouteMatch {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

const routes: RouteMatch[] = [
  // ── File Browser ──────────────────────────────────────
  {
    method: "GET",
    pattern: /^\/api\/files\/tree$/,
    handler: async (c, creds) => {
      const path = c.req.query("path") || ".";
      const depth = Number(c.req.query("depth") || 1);
      const result = await proxyGetTree(creds, path, depth);
      return c.json(result);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/files\/read$/,
    handler: async (c, creds) => {
      const path = c.req.query("path");
      if (!path) return c.json({ error: "path required" }, 400);
      const result = await proxyReadFile(creds, path);
      return c.json(result);
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/files\/write$/,
    handler: async (c, creds) => {
      const path = c.req.query("path");
      if (!path) return c.json({ error: "path required" }, 400);
      const body = await c.req.json<{
        content: string;
        expectedMtime?: number;
      }>();
      const result = await proxyWriteFile(
        creds,
        path,
        body.content,
        body.expectedMtime,
      );
      return c.json(result);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/files\/rename$/,
    handler: async (c, creds) => {
      const body = await c.req.json<{ path: string; newName: string }>();
      const result = await proxyRenameEntry(creds, body.path, body.newName);
      return c.json(result);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/files\/move$/,
    handler: async (c, creds) => {
      const body = await c.req.json<{ source: string; targetDir: string }>();
      const result = await proxyMoveEntry(creds, body.source, body.targetDir);
      return c.json(result);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/files\/trash$/,
    handler: async (c, creds) => {
      const body = await c.req.json<{ path: string }>();
      const result = await proxyTrashEntry(creds, body.path);
      return c.json(result);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/files\/raw$/,
    handler: async (c, creds) => {
      const path = c.req.query("path");
      if (!path) return c.json({ error: "path required" }, 400);
      const resp = await proxyReadImage(creds, path);
      const contentType =
        resp.headers.get("content-type") || "application/octet-stream";
      const data = await resp.arrayBuffer();
      return new Response(data, {
        status: resp.status,
        headers: { "Content-Type": contentType },
      });
    },
  },

  // ── Workspace ─────────────────────────────────────────
  {
    method: "GET",
    pattern: /^\/api\/workspace$/,
    handler: async (c, creds) => {
      const result = await proxyListWorkspaceFiles(creds);
      return c.json(result);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/workspace\/([^/]+)$/,
    handler: async (c, creds) => {
      const key = c.req.path.split("/").pop()!;
      const result = await proxyReadWorkspaceFile(creds, key);
      return c.json(result);
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/workspace\/([^/]+)$/,
    handler: async (c, creds) => {
      const key = c.req.path.split("/").pop()!;
      const body = await c.req.json<{ content: string }>();
      const result = await proxyWriteWorkspaceFile(creds, key, body.content);
      return c.json(result);
    },
  },

  // ── Memory ────────────────────────────────────────────
  {
    method: "GET",
    pattern: /^\/api\/memories$/,
    handler: async (c, creds) => {
      const result = await proxyGetMemories(creds);
      // Orchestrator wraps in { ok, entries }; Nerve frontend expects a bare array
      const entries = (result as Record<string, unknown>).entries;
      return c.json(Array.isArray(entries) ? entries : []);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/memories\/section$/,
    handler: async (c, creds) => {
      const title = c.req.query("title") || "";
      const date = c.req.query("date");
      const result = await proxyGetMemorySection(
        creds,
        title,
        date || undefined,
      );
      return c.json(result);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/memories$/,
    handler: async (c, creds) => {
      const body = await c.req.json<{ text: string; section?: string }>();
      const result = await proxyCreateMemory(creds, body.text, body.section);
      return c.json(result);
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/memories\/section$/,
    handler: async (c, creds) => {
      const body = await c.req.json<{
        title: string;
        content: string;
        date?: string;
      }>();
      const result = await proxyUpdateMemorySection(
        creds,
        body.title,
        body.content,
        body.date,
      );
      return c.json(result);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/memories$/,
    handler: async (c, creds) => {
      const body = await c.req.json<{
        query: string;
        type?: string;
        date?: string;
      }>();
      const result = await proxyDeleteMemory(
        creds,
        body.query,
        undefined,
        body.date,
      );
      return c.json(result);
    },
  },

  // ── Sessions ──────────────────────────────────────────
  {
    method: "GET",
    pattern: /^\/api\/sessions\/([^/]+)\/model$/,
    handler: async (c, creds) => {
      const parts = c.req.path.split("/");
      const sessionId = parts[parts.indexOf("sessions") + 1];
      const result = await proxyGetSessionModel(creds, sessionId);
      return c.json(result);
    },
  },

  // ── Token Usage ───────────────────────────────────────
  {
    method: "GET",
    pattern: /^\/api\/tokens$/,
    handler: async (c, creds) => {
      const result = await proxyGetTokenUsage(creds);
      return c.json(result);
    },
  },

  // ── Cron ───────────────────────────────────────────────
  {
    method: "GET",
    pattern: /^\/api\/crons$/,
    handler: async (c, creds) => {
      const result = await proxyCronList(creds);
      return c.json(result);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/crons$/,
    handler: async (c, creds) => {
      const body = await c.req.json();
      const result = await proxyCronAdd(creds, body.job);
      return c.json(result);
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/crons\/([^/]+)$/,
    handler: async (c, creds) => {
      const jobId = c.req.path.split("/").pop()!;
      const body = await c.req.json();
      const result = await proxyCronUpdate(creds, jobId, body.patch);
      return c.json(result);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/crons\/([^/]+)$/,
    handler: async (c, creds) => {
      const jobId = c.req.path.split("/").pop()!;
      const result = await proxyCronRemove(creds, jobId);
      return c.json(result);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/crons\/([^/]+)\/toggle$/,
    handler: async (c, creds) => {
      const parts = c.req.path.split("/");
      const jobId = parts[parts.length - 2];
      const body = await c.req.json().catch(() => ({ enabled: true }));
      const result = await proxyCronToggle(creds, jobId, body.enabled);
      return c.json(result);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/crons\/([^/]+)\/run$/,
    handler: async (c, creds) => {
      const parts = c.req.path.split("/");
      const jobId = parts[parts.length - 2];
      const result = await proxyCronRun(creds, jobId);
      return c.json(result);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/crons\/([^/]+)\/runs$/,
    handler: async (c, creds) => {
      const parts = c.req.path.split("/");
      const jobId = parts[parts.length - 2];
      const result = await proxyCronGetRuns(creds, jobId);
      return c.json(result);
    },
  },
];

// ── Middleware ───────────────────────────────────────────────────────

/**
 * Hono middleware that intercepts API calls and proxies them to vaani_core's
 * cockpit-proxy when remote mode is active.
 *
 * Usage in app.ts:
 * ```ts
 * import { remoteProxyMiddleware } from './middleware/remote-proxy.js';
 * app.use('/api/*', remoteProxyMiddleware);
 * ```
 */
export async function remoteProxyMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  // No-op when remote mode is disabled
  if (!isRemoteMode()) return next();

  const creds = extractCredentials(c);
  // If no credentials present, fall through to local handlers
  if (!creds) return next();

  const method = c.req.method;
  const pathname = new URL(c.req.url).pathname;

  for (const route of routes) {
    if (route.method !== method) continue;
    if (!route.pattern.test(pathname)) continue;
    try {
      return await route.handler(c, creds);
    } catch (err) {
      return handleProxyError(c, err);
    }
  }

  // No match — fall through to local handlers
  return next();
}
