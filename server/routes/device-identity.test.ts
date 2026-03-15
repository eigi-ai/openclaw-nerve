/** Tests for the GET /api/device-identity endpoint. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

describe("GET /api/device-identity", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function buildApp() {
    vi.doMock("../middleware/rate-limit.js", () => ({
      rateLimitGeneral: vi.fn((_c: unknown, next: () => Promise<void>) =>
        next(),
      ),
    }));

    vi.doMock("../lib/device-identity.js", () => ({
      getPublicDeviceIdentity: vi.fn(() => ({
        deviceId: "dev-123",
        publicKey: "pub-key-123",
        clientId: "webchat-ui",
        clientMode: "webchat",
        platform: "web",
      })),
    }));

    const mod = await import("./device-identity.js");
    const app = new Hono();
    app.route("/", mod.default);
    return app;
  }

  it("returns the public Nerve device identity payload", async () => {
    const app = await buildApp();
    const res = await app.request("/api/device-identity");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deviceId: "dev-123",
      publicKey: "pub-key-123",
      clientId: "webchat-ui",
      clientMode: "webchat",
      platform: "web",
    });
  });
});
