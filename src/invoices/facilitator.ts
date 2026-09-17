import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import type { Config } from "../config.js";

/**
 * Builds the x402 facilitator client from configuration.
 *
 * - `FACILITATOR=cdp`: the Coinbase Developer Platform facilitator, authenticated with
 *   per-request JWTs made from CDP_API_KEY_ID and CDP_API_KEY_SECRET.
 * - `FACILITATOR=<url>`: any facilitator speaking the x402 HTTP API (Cubicle's self-hosted one).
 *
 * The facilitator only verifies and broadcasts. The invoice service never credits on its
 * word; see src/invoices/service.ts. Tests pass an in-process facilitator instead of this.
 */
export function createFacilitatorClient(config: Pick<Config, "FACILITATOR" | "CDP_API_KEY_ID" | "CDP_API_KEY_SECRET">): FacilitatorClient {
  const setting = config.FACILITATOR;
  if (!setting) throw new Error("FACILITATOR is not configured: set it to cdp or a facilitator URL");
  if (setting === "cdp") {
    if (!config.CDP_API_KEY_ID || !config.CDP_API_KEY_SECRET) {
      throw new Error("FACILITATOR=cdp needs CDP_API_KEY_ID and CDP_API_KEY_SECRET");
    }
    return new HTTPFacilitatorClient(createFacilitatorConfig(config.CDP_API_KEY_ID, config.CDP_API_KEY_SECRET));
  }
  return new HTTPFacilitatorClient({ url: facilitatorUrl(setting) });
}

/**
 * Signed payloads travel to the facilitator, so a remote facilitator must be https.
 * Plain http is accepted only on loopback, for a facilitator running beside the service.
 */
function facilitatorUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FACILITATOR must be cdp or an http(s) URL");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("FACILITATOR URL must use https unless it is on loopback");
  }
  if (url.username || url.password) throw new Error("FACILITATOR URL must not embed credentials");
  return url.toString().replace(/\/+$/, "");
}
