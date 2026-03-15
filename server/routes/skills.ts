/**
 * Skills API Routes
 *
 * GET /api/skills — List all skills via `openclaw skills list --json`
 */

import { Hono, type Context } from "hono";
import { execFile, type ExecFileException } from "node:child_process";
import { dirname } from "node:path";
import { rateLimitGeneral } from "../middleware/rate-limit.js";
import { resolveOpenclawBin } from "../lib/openclaw-bin.js";

const app = new Hono();

const SKILLS_TIMEOUT_MS = 15_000;

/** Ensure PATH includes the directory of the current Node binary (for #!/usr/bin/env node shims under systemd) */
const nodeDir = dirname(process.execPath);
const enrichedEnv = {
  ...process.env,
  PATH: `${nodeDir}:${process.env.PATH || ""}`,
};

interface SkillMissing {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
  os?: string[];
}

interface RawSkill {
  name: string;
  description: string;
  emoji: string;
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  source: string;
  bundled: boolean;
  homepage?: string;
  missing?: SkillMissing;
}

interface ProxyTargetConfig {
  apiUrl: string;
  apiKey: string;
}

interface TreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeEntry[] | null;
}

interface SkillsOutput {
  workspaceDir?: string;
  managedSkillsDir?: string;
  skills?: RawSkill[];
}

class SkillsRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillsRouteError";
  }
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

async function fetchSkillsFromProxy(c: Context): Promise<RawSkill[] | null> {
  const target = resolveProxyTarget(c);
  if (!target) return null;

  const url = new URL(`${target.apiUrl}/v1/eigi/cockpit-proxy/files/tree`);
  url.searchParams.set("path", "workspace/skills");
  url.searchParams.set("depth", "2");

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-API-Key": target.apiKey,
      Accept: "application/json",
    },
  });

  if (res.status === 404) {
    return [];
  }
  if (!res.ok) {
    const text = await res.text();
    throw new SkillsRouteError(
      `Failed to read workspace skills: ${res.status} ${text.slice(0, 200)}`,
    );
  }

  const payload = (await res.json()) as { ok?: boolean; entries?: TreeEntry[] };
  const entries = Array.isArray(payload.entries) ? payload.entries : [];

  const dirEntries = entries.filter((entry) => entry.type === "directory");
  return dirEntries.map((entry) => ({
    name: entry.name,
    description: "",
    emoji: "🧩",
    eligible: true,
    disabled: false,
    blockedByAllowlist: false,
    source: "workspace",
    bundled: false,
  }));
}

function extractJsonPayload(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new SkillsRouteError("openclaw skills list returned empty output");
  }

  // Normal case: pure JSON output.
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to prelude-tolerant parsing.
  }

  // OpenClaw can print warnings before JSON.
  // Try parsing from each possible JSON structure start ({ or [).
  const startIndices: number[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "{" || ch === "[") {
      startIndices.push(i);
    }
  }

  for (const start of startIndices) {
    const candidate = trimmed.slice(start).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      // Keep scanning for the next JSON structure start.
    }
  }

  throw new SkillsRouteError("Failed to parse openclaw skills output as JSON");
}

function parseSkillsOutput(stdout: string): RawSkill[] {
  const parsed = extractJsonPayload(stdout);

  if (Array.isArray(parsed)) {
    return parsed as RawSkill[];
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as SkillsOutput).skills)
  ) {
    return (parsed as SkillsOutput).skills as RawSkill[];
  }

  throw new SkillsRouteError(
    "Invalid openclaw skills payload: missing skills array",
  );
}

function formatExecError(err: ExecFileException, stderr: string): string {
  if (err.code === "ENOENT") {
    return "openclaw CLI not found in PATH";
  }

  if (err.killed && err.signal === "SIGTERM") {
    return `openclaw skills list timed out after ${SKILLS_TIMEOUT_MS}ms`;
  }

  const stderrLine = stderr.trim().split("\n").find(Boolean);
  if (stderrLine) {
    return `openclaw skills list failed: ${stderrLine}`;
  }

  return `openclaw skills list failed: ${err.message}`;
}

function execOpenclawSkills(): Promise<RawSkill[]> {
  return new Promise((resolve, reject) => {
    const openclawBin = resolveOpenclawBin();
    execFile(
      openclawBin,
      ["skills", "list", "--json"],
      {
        timeout: SKILLS_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        env: enrichedEnv,
      },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new SkillsRouteError(formatExecError(err, stderr)));
        }

        try {
          return resolve(parseSkillsOutput(stdout));
        } catch (parseErr) {
          if (parseErr instanceof SkillsRouteError) {
            return reject(parseErr);
          }
          return reject(
            new SkillsRouteError(
              (parseErr as Error).message || "Failed to parse skills output",
            ),
          );
        }
      },
    );
  });
}

app.get("/api/skills", rateLimitGeneral, async (c) => {
  try {
    const proxiedSkills = await fetchSkillsFromProxy(c);
    if (proxiedSkills !== null) {
      return c.json({ ok: true, skills: proxiedSkills });
    }

    const skills = await execOpenclawSkills();
    return c.json({ ok: true, skills });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to list skills";
    console.error("[skills] list error:", message);
    return c.json({ ok: false, error: message }, 502);
  }
});

export default app;
