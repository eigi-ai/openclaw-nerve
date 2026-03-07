/**
 * useConnectionManager - Handles gateway connection lifecycle
 *
 * Extracted from App.tsx to separate connection concerns from layout.
 * Manages auto-connect on mount and reconnect logic.
 *
 * Priority order for gateway credentials (highest wins):
 *   1. URL query params (`?gateway=…&token=…`) — used by "Open Cockpit" deep links
 *   2. localStorage (`oc-config`) — persisted from previous session
 *   3. /api/connect-defaults — server-side .env fallback (loopback only)
 *
 * When URL params are present the token is saved to localStorage and the
 * sensitive params are stripped from the address bar via replaceState.
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { useGateway, loadConfig, saveConfig } from "@/contexts/GatewayContext";
import { DEFAULT_GATEWAY_WS } from "@/lib/constants";

export interface ConnectionManagerState {
  dialogOpen: boolean;
  setDialogOpen: (open: boolean) => void;
  editableUrl: string;
  setEditableUrl: (url: string) => void;
  editableToken: string;
  setEditableToken: (token: string) => void;
  editableApiKey: string;
  setEditableApiKey: (key: string) => void;
  editableApiUrl: string;
  setEditableApiUrl: (url: string) => void;
  handleConnect: (url: string, token: string) => Promise<void>;
  handleReconnect: () => Promise<void>;
}

/** Create an AbortSignal that times out after `ms` milliseconds. */
function timeoutSignal(ms: number): AbortSignal {
  // AbortSignal.timeout() not supported in Safari <16.4
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** Fetch gateway connection defaults from the Nerve server. */
async function fetchConnectDefaults(): Promise<{
  wsUrl: string;
  token: string | null;
} | null> {
  try {
    const resp = await fetch("/api/connect-defaults", {
      signal: timeoutSignal(3000),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/**
 * Read `gateway`, `token`, `apiKey`, and `apiUrl` from URL query params,
 * then strip them from the address bar so secrets aren't visible in
 * history / bookmarks.
 *
 * Returns `{ url, token, apiKey?, apiUrl? }` if gateway+token are present,
 * otherwise `null`.
 */
function consumeUrlParams(): {
  url: string;
  token: string;
  apiKey?: string;
  apiUrl?: string;
} | null {
  const params = new URLSearchParams(window.location.search);
  const gateway = params.get("gateway");
  const token = params.get("token");

  if (!gateway || !token) return null;

  const apiKey = params.get("apiKey") || undefined;
  const apiUrl = params.get("apiUrl") || undefined;

  // Strip sensitive params from the browser address bar
  params.delete("gateway");
  params.delete("token");
  params.delete("apiKey");
  params.delete("apiUrl");
  const remaining = params.toString();
  const cleanUrl =
    window.location.pathname +
    (remaining ? `?${remaining}` : "") +
    window.location.hash;
  window.history.replaceState({}, "", cleanUrl);

  return { url: gateway, token, apiKey, apiUrl };
}

export function useConnectionManager(): ConnectionManagerState {
  const { connectionState, connect, disconnect } = useGateway();

  const [dialogOpen, setDialogOpen] = useState(true);

  // Editable connection settings (local state for settings drawer)
  // Lazy initializers avoid re-parsing sessionStorage on every render
  const [editableUrl, setEditableUrl] = useState(
    () => loadConfig().url || DEFAULT_GATEWAY_WS,
  );
  const [editableToken, setEditableToken] = useState(
    () => loadConfig().token || "",
  );
  const [editableApiKey, setEditableApiKey] = useState(
    () => loadConfig().apiKey || "",
  );
  const [editableApiUrl, setEditableApiUrl] = useState(
    () => loadConfig().apiUrl || "",
  );

  // Track if we've attempted auto-connect to avoid re-running
  const autoConnectAttempted = useRef(false);

  // Persist proxy credentials to oc-config whenever they change,
  // so proxy-fetch interceptor picks them up immediately.
  useEffect(() => {
    const saved = loadConfig();
    if (saved.url && saved.token) {
      saveConfig(
        saved.url,
        saved.token,
        editableApiKey || undefined,
        editableApiUrl || undefined,
      );
    }
  }, [editableApiKey, editableApiUrl]);

  // Resolve credentials: URL params > localStorage > server defaults
  useEffect(() => {
    if (autoConnectAttempted.current) return;
    autoConnectAttempted.current = true;

    // 1. URL params take highest priority (deep link from "Open Cockpit").
    //    Always consumed — even if localStorage already has a saved config,
    //    the URL params carry the CURRENT token which may have rotated.
    const urlCreds = consumeUrlParams();
    if (urlCreds) {
      setEditableUrl(urlCreds.url);
      setEditableToken(urlCreds.token);
      if (urlCreds.apiKey) setEditableApiKey(urlCreds.apiKey);
      if (urlCreds.apiUrl) setEditableApiUrl(urlCreds.apiUrl);
      saveConfig(
        urlCreds.url,
        urlCreds.token,
        urlCreds.apiKey,
        urlCreds.apiUrl,
      );
      // Auto-connect immediately — skip the dialog
      connect(urlCreds.url, urlCreds.token)
        .then(() => setDialogOpen(false))
        .catch(() => {
          /* dialog will show on failure */
        });
      return;
    }

    // 2. localStorage (previous session) — auto-connect with saved creds
    const saved = loadConfig();
    if (saved.url && saved.token) {
      connect(saved.url, saved.token)
        .then(() => setDialogOpen(false))
        .catch(() => {
          /* dialog will show on failure */
        });
      return;
    }

    // 3. Server-side defaults (/api/connect-defaults)
    fetchConnectDefaults().then((defaults) => {
      if (defaults?.wsUrl) setEditableUrl(defaults.wsUrl);
      if (defaults?.token) setEditableToken(defaults.token);
      // Auto-connect if both URL and token are available
      if (defaults?.wsUrl && defaults?.token) {
        connect(defaults.wsUrl, defaults.token)
          .then(() => setDialogOpen(false))
          .catch(() => {
            /* dialog will show on failure */
          });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time mount effect
  }, []);

  const handleConnect = useCallback(
    async (url: string, token: string) => {
      saveConfig(
        url,
        token,
        editableApiKey || undefined,
        editableApiUrl || undefined,
      );
      await connect(url, token);
      setDialogOpen(false);
    },
    [connect, editableApiKey, editableApiUrl],
  );

  const handleReconnect = useCallback(async () => {
    // Don't reconnect if already connecting
    if (
      connectionState === "connecting" ||
      connectionState === "reconnecting"
    ) {
      return;
    }

    if (editableUrl && editableToken) {
      // Save the new config first (include proxy credentials)
      saveConfig(
        editableUrl,
        editableToken,
        editableApiKey || undefined,
        editableApiUrl || undefined,
      );
      // Disconnect cleanly, then reconnect
      disconnect();
      // Small delay to ensure clean disconnect
      await new Promise((r) => setTimeout(r, 100));
      try {
        await connect(editableUrl, editableToken);
      } catch {
        // Connection failed - don't loop, just stay disconnected
      }
    } else {
      setDialogOpen(true);
    }
  }, [
    connect,
    disconnect,
    editableUrl,
    editableToken,
    editableApiKey,
    editableApiUrl,
    connectionState,
  ]);

  return {
    dialogOpen,
    setDialogOpen,
    editableUrl,
    setEditableUrl,
    editableToken,
    setEditableToken,
    editableApiKey,
    setEditableApiKey,
    editableApiUrl,
    setEditableApiUrl,
    handleConnect,
    handleReconnect,
  };
}
