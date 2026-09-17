import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * One chain family's side of an invoice: what to ask the payer for, how to tie a
 * signed payment to the invoice, and how to confirm it independently over our
 * own RPC. The invoice service never credits on a facilitator response alone;
 * it credits when `confirm` returns `confirmed`.
 */

export type RailConfig = {
  /** CAIP-2 network as stored and shown, e.g. eip155:84532 or solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1. */
  network: string;
  /** CAIP-2 network sent to x402. Equals `network` except for local chains (a local Solana validator is labelled devnet). */
  wireNetwork: string;
  /** USDC contract address (EVM) or mint (Solana). 6 decimals. */
  asset: string;
  /** Receiving address. Public; its key is the owner's. */
  payTo: string;
  /** Our own RPC, never the facilitator's. */
  rpcUrl: string;
  /** Scheme-specific requirement extras: EIP-712 domain name and version on EVM, feePayer on Solana. */
  extra: Record<string, unknown>;
};

/** Ties a payment payload to an invoice. Stored with the invoice before any facilitator call. */
export type Binding = {
  payer: string;
  /** EVM: the EIP-3009 authorization nonce. Solana: the payer's signature on the transaction. */
  bindingId: string;
};

export type Confirmation =
  | { state: "confirmed"; transaction: string; payer: string }
  | { state: "pending" }
  | { state: "failed"; reason: string };

export interface Rail {
  readonly config: RailConfig;
  /** x402 v2 `exact` requirements for this amount, in atomic USDC units. */
  requirements(amountMicro: bigint, maxTimeoutSeconds: number): PaymentRequirements;
  /**
   * Checks that the payload pays exactly these requirements (scheme, network, asset,
   * payTo, amount, validity window) and returns its binding. Throws a PaymentMismatchError otherwise.
   */
  bind(payload: PaymentPayload, requirements: PaymentRequirements): Binding;
  /** A chain position (EVM block number, Solana slot) to start recovery scans from. Captured when an invoice is created. */
  checkpoint(): Promise<string>;
  /**
   * Looks for the settled transfer on chain: exactly `requirements.amount` of `asset` from
   * `binding.payer` to `payTo`, tied to `binding.bindingId`, with enough confirmations (EVM)
   * or finalized (Solana). `transaction` is the facilitator's reported hash when known; without
   * it (a lost response), scan forward from `checkpoint`. Returns `failed` only when the chain
   * proves the payment can no longer land (EVM: authorization unused and expired at a finalized block).
   */
  confirm(input: {
    requirements: PaymentRequirements;
    binding: Binding;
    checkpoint: string;
    transaction?: string;
    validBefore: Date;
  }): Promise<Confirmation>;
}

export class PaymentMismatchError extends Error {
  constructor(readonly reason: string) {
    super(`payment does not match the invoice: ${reason}`);
  }
}
