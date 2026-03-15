/**
 * GET /api/device-identity — public Nerve gateway device identity.
 *
 * This exposes only the public device identity fields needed by trusted
 * deploy infrastructure to pre-seed OpenClaw's pairing store for Nerve.
 * No private key or bearer secret is returned.
 */

import { Hono } from "hono";
import { getPublicDeviceIdentity } from "../lib/device-identity.js";
import { rateLimitGeneral } from "../middleware/rate-limit.js";

const app = new Hono();

app.get("/api/device-identity", rateLimitGeneral, (c) => {
  return c.json(getPublicDeviceIdentity());
});

export default app;
