/**
 * Fetch interceptor for remote proxy credentials.
 *
 * When Nerve runs in remote/shared mode and the user's `oc-config` in
 * localStorage contains `apiKey` and `apiUrl`, this interceptor adds
 * `X-Proxy-Api-Key` and `X-Proxy-Api-Url` headers to all `/api/*` fetch
 * requests so the Nerve server middleware can forward them to vaani_core.
 *
 * Call `installProxyFetchInterceptor()` once at app startup (main.tsx).
 */

function loadProxyConfig(): { apiKey?: string; apiUrl?: string } {
  try {
    const config = JSON.parse(localStorage.getItem("oc-config") || "{}");
    return { apiKey: config.apiKey, apiUrl: config.apiUrl };
  } catch {
    return {};
  }
}

export function installProxyFetchInterceptor(): void {
  const originalFetch = window.fetch;

  window.fetch = function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // Only intercept relative /api/* requests
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (!url.startsWith("/api/")) {
      return originalFetch.call(window, input, init);
    }

    const { apiKey, apiUrl } = loadProxyConfig();
    if (!apiKey || !apiUrl) {
      return originalFetch.call(window, input, init);
    }

    // Clone headers and add proxy credentials
    const headers = new Headers(init?.headers);
    headers.set("X-Proxy-Api-Key", apiKey);
    headers.set("X-Proxy-Api-Url", apiUrl);

    return originalFetch.call(window, input, { ...init, headers });
  };
}
