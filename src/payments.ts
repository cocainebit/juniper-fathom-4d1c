import type { FacilitatorClient } from "@x402/core/server";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { createEvmRailFromConfig } from "./invoices/evm.js";
import { createFacilitatorClient } from "./invoices/facilitator.js";
import type { Rail } from "./invoices/rail.js";
import { createInvoiceService, type InvoiceService } from "./invoices/service.js";
import { createSolanaRail, solanaNetworks } from "./invoices/solana.js";

/** What the account page offers: one entry per enabled network. Public data only. */
export type PaymentOption = { network: string; chainFamily: "eip155" | "solana"; label: string; asset: string; payTo: string };

export type Payments = { invoices: InvoiceService; options: PaymentOption[]; stop: () => void };

const LABELS: Record<string, string> = {
  "eip155:8453": "USDC on Base",
  "eip155:84532": "USDC on Base Sepolia (testnet)",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "USDC on Solana",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "USDC on Solana devnet (testnet)",
};

/**
 * Builds invoices from configuration, or returns null when payments are not set up
 * (no facilitator, or no receiving address with an RPC). Each chain is enabled only
 * when both its receiving address and our own RPC are configured.
 */
export async function createPayments(db: Db, config: Config, facilitator?: FacilitatorClient): Promise<Payments | null> {
  if (!config.FACILITATOR && !facilitator) return null;
  const client = facilitator ?? createFacilitatorClient(config);
  const rails = new Map<string, Rail>();
  const options: PaymentOption[] = [];

  if (config.PAY_TO_EVM && config.EVM_RPC_URL) {
    const rail = createEvmRailFromConfig(config);
    rails.set(rail.config.network, rail);
    options.push({ network: rail.config.network, chainFamily: "eip155", label: LABELS[rail.config.network] ?? rail.config.network, asset: rail.config.asset, payTo: rail.config.payTo });
  }

  if (config.PAY_TO_SOLANA && config.SOLANA_RPC_URL && config.SOLANA_USDC) {
    const { network, wireNetwork } = await solanaNetworks(config.SOLANA_RPC_URL);
    if (network !== config.SOLANA_NETWORK && network === wireNetwork)
      throw new Error(`SOLANA_RPC_URL serves ${network}, but SOLANA_NETWORK is ${config.SOLANA_NETWORK}`);
    // The facilitator pays Solana fees, so the transaction names its fee payer.
    const supported = await client.getSupported();
    const kind = supported.kinds.find((k) => k.scheme === "exact" && k.network === wireNetwork);
    const feePayer = kind?.extra?.feePayer;
    if (typeof feePayer !== "string") throw new Error(`The facilitator does not settle exact payments on ${wireNetwork}`);
    const rail = createSolanaRail({ network, wireNetwork, asset: config.SOLANA_USDC, payTo: config.PAY_TO_SOLANA, rpcUrl: config.SOLANA_RPC_URL, extra: { feePayer } });
    rails.set(network, rail);
    options.push({ network, chainFamily: "solana", label: LABELS[network] ?? network, asset: config.SOLANA_USDC, payTo: config.PAY_TO_SOLANA });
  }

  if (rails.size === 0) return null;
  const invoices = createInvoiceService({ db, rails, facilitator: client, payloadKey: config.PAYLOAD_KEY, publicUrl: config.PUBLIC_URL });

  // Finish settlements whose response was lost and expire stale invoices, one pass at a time.
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    invoices
      .reconcile()
      .catch((error) => console.error("invoice reconcile failed:", error))
      .finally(() => {
        running = false;
      });
  }, 5_000);
  timer.unref();
  return { invoices, options, stop: () => clearInterval(timer) };
}
