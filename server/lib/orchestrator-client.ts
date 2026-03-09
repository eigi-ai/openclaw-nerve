/**
 * HTTP client for the vaani_core cockpit proxy.
 *
 * Used when Nerve runs in **remote mode** (NERVE_REMOTE_MODE=true). Instead of
 * reading the host filesystem, Nerve proxies file operations to vaani_core's
 * `/v1/eigi/cockpit-proxy/*` endpoint, which resolves the user's node and
 * forwards to the correct orchestrator.
 *
 * Authentication: The user's API key (`vk_...`) is passed per-request via
 * the `X-Api-Key` and `X-Api-Url` headers from the Nerve frontend (injected
 * from the deep-link URL params and stored in localStorage).
 *
 * @module
 */

import { config } from "./config.js";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Whether remote proxy mode is active. */
export function isRemoteMode(): boolean {
  return (config as Record<string, unknown>).remoteMode === true;
}

// ── Generic fetcher ─────────────────────────────────────────────────

interface ProxyResponse {
  ok: boolean;
  [key: string]: unknown;
}

/**
 * Per-request credentials passed from the Nerve frontend via headers.
 * These come from the deep-link URL params (apiKey + apiUrl).
 */
export interface ProxyCredentials {
  apiKey: string;
  apiUrl: string;
}

async function proxyFetch(
  method: string,
  path: string,
  creds: ProxyCredentials,
  opts?: {
    body?: unknown;
    query?: Record<string, string | number | undefined>;
    timeoutMs?: number;
    rawResponse?: boolean;
  },
): Promise<Response | ProxyResponse> {
  // vaani_core cockpit-proxy prefix — maps /proxy/files/tree → /v1/eigi/cockpit-proxy/files/tree
  const proxyPath = path.replace(/^\/proxy\//, "/v1/eigi/cockpit-proxy/");
  const url = new URL(proxyPath, creds.apiUrl);

  if (opts?.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    "X-API-Key": creds.apiKey,
  };
  if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  if (opts?.rawResponse) return response;

  if (!response.ok) {
    const text = await response.text();
    throw new ProxyError(response.status, text);
  }

  return (await response.json()) as ProxyResponse;
}

export class ProxyError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(`Cockpit proxy error ${status}: ${detail}`);
    this.name = "ProxyError";
    this.status = status;
    this.detail = detail;
  }
}

// ── File Browser ────────────────────────────────────────────────────

export async function proxyGetTree(
  creds: ProxyCredentials,
  relPath = ".",
  depth = 1,
): Promise<ProxyResponse> {
  return (await proxyFetch("GET", "/proxy/files/tree", creds, {
    query: { path: relPath, depth },
  })) as ProxyResponse;
}

export async function proxyReadFile(
  creds: ProxyCredentials,
  relPath: string,
): Promise<ProxyResponse> {
  return (await proxyFetch("GET", "/proxy/files/read", creds, {
    query: { path: relPath },
  })) as ProxyResponse;
}

export async function proxyWriteFile(
  creds: ProxyCredentials,
  relPath: string,
  content: string,
  expectedMtime?: number,
): Promise<ProxyResponse> {
  return (await proxyFetch("POST", "/proxy/files/write", creds, {
    query: { path: relPath },
    body: { content, expected_mtime: expectedMtime },
  })) as ProxyResponse;
}

export async function proxyRenameEntry(
  creds: ProxyCredentials,
  relPath: string,
  newName: string,
): Promise<ProxyResponse> {
  return (await proxyFetch("POST", "/proxy/files/rename", creds, {
    query: { path: relPath },
    body: { new_name: newName },
  })) as ProxyResponse;
}

export async function proxyMoveEntry(
  creds: ProxyCredentials,
  sourcePath: string,
  targetDir: string,
): Promise<ProxyResponse> {
  return (await proxyFetch("POST", "/proxy/files/move", creds, {
    query: { path: sourcePath },
    body: { target_dir: targetDir },
  })) as ProxyResponse;
}

export async function proxyTrashEntry(
  creds: ProxyCredentials,
  relPath: string,
): Promise<ProxyResponse> {
  return (await proxyFetch("DELETE", "/proxy/files/trash", creds, {
    query: { path: relPath },
  })) as ProxyResponse;
}

export async function proxyReadImage(
  creds: ProxyCredentials,
  relPath: string,
): Promise<Response> {
  return (await proxyFetch("GET", "/proxy/files/image", creds, {
    query: { path: relPath },
    rawResponse: true,
  })) as Response;
}

// ── Workspace ───────────────────────────────────────────────────────

export async function proxyListWorkspaceFiles(
  creds: ProxyCredentials,
): Promise<ProxyResponse> {
  return (await proxyFetch(
    "GET",
    "/proxy/workspace/files",
    creds,
  )) as ProxyResponse;
}

export async function proxyReadWorkspaceFile(
  creds: ProxyCredentials,
  key: string,
): Promise<ProxyResponse> {
  return (await proxyFetch("GET", "/proxy/workspace/file", creds, {
    query: { key },
  })) as ProxyResponse;
}

export async function proxyWriteWorkspaceFile(
  creds: ProxyCredentials,
  key: string,
  content: string,
): Promise<ProxyResponse> {
  return (await proxyFetch("POST", "/proxy/workspace/file", creds, {
    query: { key },
    body: { content },
  })) as ProxyResponse;
}

// ── Memory ──────────────────────────────────────────────────────────

export async function proxyGetMemories(
  creds: ProxyCredentials,
): Promise<ProxyResponse> {
  return (await proxyFetch("GET", "/proxy/memory", creds)) as ProxyResponse;
}

export async function proxyCreateMemory(
  creds: ProxyCredentials,
  text: string,
  section?: string,
): Promise<ProxyResponse> {
  return (await proxyFetch("POST", "/proxy/memory", creds, {
    body: { text, section: section || "General" },
  })) as ProxyResponse;
}

export async function proxyGetMemorySection(
  creds: ProxyCredentials,
  title: string,
  date?: string,
): Promise<ProxyResponse> {
  return (await proxyFetch("GET", "/proxy/memory/section", creds, {
    query: { title, date },
  })) as ProxyResponse;
}

export async function proxyUpdateMemorySection(
  creds: ProxyCredentials,
  title: string,
  content: string,
  date?: string,
): Promise<ProxyResponse> {
  return (await proxyFetch("PUT", "/proxy/memory/section", creds, {
    body: { title, content, date },
  })) as ProxyResponse;
}

export async function proxyDeleteMemory(
  creds: ProxyCredentials,
  section: string,
  item?: string,
  date?: string,
): Promise<ProxyResponse> {
  return (await proxyFetch("DELETE", "/proxy/memory", creds, {
    body: { section, item, date },
  })) as ProxyResponse;
}

// ── Sessions ────────────────────────────────────────────────────────

export async function proxyGetSessionModel(
  creds: ProxyCredentials,
  sessionId: string,
): Promise<ProxyResponse> {
  return (await proxyFetch(
    "GET",
    `/proxy/sessions/${encodeURIComponent(sessionId)}/model`,
    creds,
  )) as ProxyResponse;
}

// ── Token Usage ─────────────────────────────────────────────────────

export async function proxyGetTokenUsage(
  creds: ProxyCredentials,
): Promise<ProxyResponse> {
  return (await proxyFetch("GET", "/proxy/tokens", creds)) as ProxyResponse;
}

// ── Cron (gateway tool proxy) ───────────────────────────────────────

export async function proxyCronList(
  creds: ProxyCredentials,
): Promise<ProxyResponse> {
  return (await proxyFetch("GET", "/proxy/crons", creds)) as ProxyResponse;
}

export async function proxyCronAdd(
  creds: ProxyCredentials,
  job: Record<string, unknown>,
): Promise<ProxyResponse> {
  return (await proxyFetch("POST", "/proxy/crons", creds, {
    body: { job },
    timeoutMs: 30_000,
  })) as ProxyResponse;
}

export async function proxyCronUpdate(
  creds: ProxyCredentials,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<ProxyResponse> {
  return (await proxyFetch(
    "PATCH",
    `/proxy/crons/${encodeURIComponent(jobId)}`,
    creds,
    { body: { patch } },
  )) as ProxyResponse;
}

export async function proxyCronRemove(
  creds: ProxyCredentials,
  jobId: string,
): Promise<ProxyResponse> {
  return (await proxyFetch(
    "DELETE",
    `/proxy/crons/${encodeURIComponent(jobId)}`,
    creds,
  )) as ProxyResponse;
}

export async function proxyCronToggle(
  creds: ProxyCredentials,
  jobId: string,
  enabled: boolean,
): Promise<ProxyResponse> {
  return (await proxyFetch(
    "POST",
    `/proxy/crons/${encodeURIComponent(jobId)}/toggle`,
    creds,
    { body: { patch: { enabled } } },
  )) as ProxyResponse;
}

export async function proxyCronRun(
  creds: ProxyCredentials,
  jobId: string,
): Promise<ProxyResponse> {
  return (await proxyFetch(
    "POST",
    `/proxy/crons/${encodeURIComponent(jobId)}/run`,
    creds,
    { timeoutMs: 90_000 },
  )) as ProxyResponse;
}

export async function proxyCronGetRuns(
  creds: ProxyCredentials,
  jobId: string,
  limit = 10,
): Promise<ProxyResponse> {
  return (await proxyFetch(
    "GET",
    `/proxy/crons/${encodeURIComponent(jobId)}/runs`,
    creds,
    { query: { limit } },
  )) as ProxyResponse;
}
