/**
 * Workspace file API Routes
 *
 * GET  /api/workspace/:key  — Read a workspace file by key
 * PUT  /api/workspace/:key  — Write a workspace file by key
 *
 * Strict allowlist of keys → files. No directory traversal.
 */

import { Hono, type Context } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../lib/config.js";
import { readText } from "../lib/files.js";
import { rateLimitGeneral } from "../middleware/rate-limit.js";

const app = new Hono();

/** Workspace base directory — parent of memoryPath */
const workspacePath = path.dirname(config.memoryPath);

/** Strict allowlist mapping key → filename */
const FILE_MAP: Record<string, string> = {
  soul: "SOUL.md",
  tools: "TOOLS.md",
  identity: "IDENTITY.md",
  user: "USER.md",
  agents: "AGENTS.md",
  heartbeat: "HEARTBEAT.md",
};

function resolveFile(key: string): string | null {
  const filename = FILE_MAP[key];
  if (!filename) return null;
  return path.join(workspacePath, filename);
}

interface ProxyTargetConfig {
  apiUrl: string;
  apiKey: string;
}

function normalizeApiUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return value.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function resolveProxyTarget(c: Context): ProxyTargetConfig | null {
  const headerApiKey = c.req.header("X-Proxy-Api-Key");
  const headerApiUrl = c.req.header("X-Proxy-Api-Url");
  if (headerApiKey && headerApiUrl) {
    const apiUrl = normalizeApiUrl(headerApiUrl);
    if (!apiUrl) return null;
    return { apiUrl, apiKey: headerApiKey.trim() };
  }

  const referer = c.req.header("Referer");
  if (!referer) return null;
  try {
    const url = new URL(referer);
    const apiKey = url.searchParams.get("apiKey")?.trim();
    const apiUrlRaw = url.searchParams.get("apiUrl")?.trim();
    if (!apiKey || !apiUrlRaw) return null;
    const apiUrl = normalizeApiUrl(apiUrlRaw);
    if (!apiUrl) return null;
    return { apiUrl, apiKey };
  } catch {
    return null;
  }
}

async function proxyReadWorkspaceFile(c: Context, filename: string) {
  const target = resolveProxyTarget(c);
  if (!target) return null;

  const url = new URL(`${target.apiUrl}/v1/eigi/cockpit-proxy/files/read`);
  url.searchParams.set("path", `workspace/${filename}`);

  const upstream = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-API-Key": target.apiKey,
      Accept: "application/json",
    },
  });

  const text = await upstream.text();
  const contentType =
    upstream.headers.get("content-type") || "application/json";
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": contentType },
  });
}

async function proxyWriteWorkspaceFile(
  c: Context,
  filename: string,
  content: string,
) {
  const target = resolveProxyTarget(c);
  if (!target) return null;

  const url = `${target.apiUrl}/v1/eigi/cockpit-proxy/files/write`;
  const upstream = await fetch(url, {
    method: "PUT",
    headers: {
      "X-API-Key": target.apiKey,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path: `workspace/${filename}`, content }),
  });

  const text = await upstream.text();
  const contentType =
    upstream.headers.get("content-type") || "application/json";
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": contentType },
  });
}

async function proxyWorkspaceIndex(c: Context) {
  const target = resolveProxyTarget(c);
  if (!target) return null;

  const url = new URL(`${target.apiUrl}/v1/eigi/cockpit-proxy/files/tree`);
  url.searchParams.set("path", "workspace");
  url.searchParams.set("depth", "1");

  const upstream = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-API-Key": target.apiKey,
      Accept: "application/json",
    },
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") || "application/json",
      },
    });
  }

  const payload = (await upstream.json()) as {
    ok?: boolean;
    entries?: Array<{ name?: string; type?: string }>;
  };
  const found = new Set(
    (payload.entries || [])
      .filter(
        (entry) => entry.type === "file" && typeof entry.name === "string",
      )
      .map((entry) => entry.name as string),
  );

  const files = Object.entries(FILE_MAP).map(([key, mapped]) => ({
    key,
    filename: mapped,
    exists: found.has(mapped),
  }));

  return new Response(JSON.stringify({ ok: true, files }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

app.get("/api/workspace/:key", rateLimitGeneral, async (c) => {
  const key = c.req.param("key");
  const filename = FILE_MAP[key];
  if (!filename) return c.json({ ok: false, error: "Unknown file key" }, 400);

  const proxied = await proxyReadWorkspaceFile(c, filename);
  if (proxied) return proxied;

  const filePath = resolveFile(key);
  if (!filePath) return c.json({ ok: false, error: "Unknown file key" }, 400);

  try {
    await fs.access(filePath);
  } catch {
    return c.json({ ok: false, error: "File not found" }, 404);
  }

  const content = await readText(filePath);
  return c.json({ ok: true, content });
});

app.put("/api/workspace/:key", rateLimitGeneral, async (c) => {
  const key = c.req.param("key");
  const filename = FILE_MAP[key];
  if (!filename) return c.json({ ok: false, error: "Unknown file key" }, 400);

  const body = await c.req.json<{ content: string }>();
  if (typeof body.content !== "string") {
    return c.json({ ok: false, error: "Missing content field" }, 400);
  }
  if (body.content.length > 100_000) {
    return c.json({ ok: false, error: "Content too large (max 100KB)" }, 400);
  }

  const proxied = await proxyWriteWorkspaceFile(c, filename, body.content);
  if (proxied) return proxied;

  const filePath = resolveFile(key);
  if (!filePath) return c.json({ ok: false, error: "Unknown file key" }, 400);

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body.content, "utf-8");
    return c.json({ ok: true });
  } catch (err) {
    console.error("[workspace] PUT error:", (err as Error).message);
    return c.json({ ok: false, error: "Failed to write file" }, 500);
  }
});

/** List available workspace file keys and their existence status */
app.get("/api/workspace", rateLimitGeneral, async (c) => {
  const proxied = await proxyWorkspaceIndex(c);
  if (proxied) return proxied;

  const files: Array<{ key: string; filename: string; exists: boolean }> = [];
  for (const [key, filename] of Object.entries(FILE_MAP)) {
    const filePath = path.join(workspacePath, filename);
    let exists = false;
    try {
      await fs.access(filePath);
      exists = true;
    } catch {
      /* not found */
    }
    files.push({ key, filename, exists });
  }
  return c.json({ ok: true, files });
});

export default app;
