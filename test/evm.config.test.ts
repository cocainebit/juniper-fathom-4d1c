import { describe, expect, it } from "vitest";
import { createEvmRailFromConfig } from "../src/charges/evm.js";

// No chain is contacted: building a rail makes no RPC call.
const base = {
  EVM_RPC_URL: "http://127.0.0.1:8761",
  PAY_TO_EVM: "0x1111111111111111111111111111111111111111",
  EVM_USDC: undefined,
  EVM_CONFIRMATIONS: 3,
};

describe("EVM rail from configuration", () => {
  it("uses the canonical USDC and its EIP-712 domain from x402's asset table", () => {
    const sepolia = createEvmRailFromConfig({ ...base, EVM_NETWORK: "eip155:84532" }).requirements(1_000_000n, 300);
    expect(sepolia).toMatchObject({ network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", extra: { name: "USDC", version: "2" } });
    const mainnet = createEvmRailFromConfig({ ...base, EVM_NETWORK: "eip155:8453" }).requirements(1_000_000n, 300);
    expect(mainnet).toMatchObject({ network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", extra: { name: "USD Coin", version: "2" } });
  });

  it("refuses another token, another network, or missing settings", () => {
    expect(() => createEvmRailFromConfig({ ...base, EVM_NETWORK: "eip155:84532", EVM_USDC: "0x2222222222222222222222222222222222222222" })).toThrow(/canonical USDC/);
    expect(createEvmRailFromConfig({ ...base, EVM_NETWORK: "eip155:84532", EVM_USDC: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" }).config.asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(() => createEvmRailFromConfig({ ...base, EVM_NETWORK: "eip155:31337" })).toThrow(/support/);
    expect(() => createEvmRailFromConfig({ ...base, EVM_NETWORK: "eip155:84532", PAY_TO_EVM: undefined })).toThrow(/PAY_TO_EVM/);
  });
});
