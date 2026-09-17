import { hasEthereum, payChargeWithEthereum, UserFacingError } from "./wallets.js";

/**
 * The payment sheet. Every product opens this page for a charge, so the prompt is
 * the same everywhere. It shows what is being paid for and asks the wallet for one
 * transfer of exactly that amount. Nothing is stored up: this pays this action only.
 */

const $ = (id) => document.getElementById(id);
const chargeId = decodeURIComponent(location.pathname.split("/").pop() ?? "");
const usdc = (micro) => (micro / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const products = { plotform: "Plotform", cubicle: "Cubicle", floatlane: "Floatlane", platform: "Platform" };
const say = (text, tone = "") => {
  const node = $("status");
  node.textContent = text;
  node.className = `hint ${tone}`;
};

/** Tells the product's window that this charge is paid, for pages that would rather listen than poll. */
function announce(charge) {
  try {
    window.opener?.postMessage({ type: "platform:charge", id: charge.id, status: charge.status }, "*");
  } catch {
    // A cross-origin opener that refuses the message changes nothing: the product polls too.
  }
}

/** The server names its own networks; never guess a chain from its id. */
async function networkLabel(network) {
  try {
    const { options } = await (await fetch("/v1/payment-options")).json();
    return options.find((option) => option.network === network)?.label ?? network;
  } catch {
    return network;
  }
}

async function load() {
  const response = await fetch(`/v1/charges/${encodeURIComponent(chargeId)}`);
  if (!response.ok) {
    $("title").textContent = "Payment not found";
    $("what").textContent = "This payment request does not exist. Go back to the product and try the action again.";
    $("actions").hidden = true;
    $("agent-note").hidden = true;
    $("amount").textContent = "";
    return null;
  }
  const charge = await response.json();
  $("product").textContent = products[charge.service] ?? charge.service;
  $("title").textContent = charge.description || "Payment";
  $("what").textContent = charge.units > 1 ? `${charge.units} x ${charge.sku}` : charge.sku;
  $("amount").replaceChildren(document.createTextNode(usdc(charge.amountMicro)), Object.assign(document.createElement("small"), { textContent: "USDC" }));
  $("network").textContent = await networkLabel(charge.network);
  $("payment-url").textContent = charge.paymentUrl;
  $("foot").textContent = "You are paying for this action only. There is no balance and nothing renews.";
  document.querySelector(".pay-card").setAttribute("aria-busy", "false");
  show(charge);
  return charge;
}

function show(charge) {
  const payable = charge.status === "open";
  $("actions").hidden = !payable;
  $("agent-note").hidden = !payable;
  if (charge.status === "paid") {
    $("done").textContent = "Paid. You can close this window and continue.";
    announce(charge);
    return;
  }
  $("done").textContent = "";
  if (charge.status === "settlement_pending") {
    $("error").textContent = "";
    $("actions").hidden = false;
    $("pay").hidden = true;
    say("This payment is settling on chain. Do not pay again; this window updates by itself.");
    return;
  }
  if (charge.status === "expired") $("error").textContent = "This payment request expired. Go back to the product and try the action again.";
  if (charge.status === "failed") $("error").textContent = `This payment did not go through: ${charge.failureReason ?? "it was refused on chain"}. Nothing was paid. Try the action again.`;
}

async function waitForSettlement() {
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const charge = await (await fetch(`/v1/charges/${encodeURIComponent(chargeId)}`)).json();
    if (charge.status !== "settlement_pending") return charge;
  }
  return null;
}

$("pay").addEventListener("click", async () => {
  const button = $("pay");
  button.disabled = true;
  $("error").textContent = "";
  try {
    say("Confirm the payment in your wallet");
    const result = await payChargeWithEthereum(chargeId);
    let charge = result.charge;
    if (!charge || charge.status === "settlement_pending") {
      say("Settling on chain. This usually takes under a minute.");
      charge = (await waitForSettlement()) ?? charge;
    }
    if (charge?.status === "paid") {
      show(charge);
      say("");
    } else if (charge?.status === "failed") {
      show(charge);
    } else {
      say("Still settling. Leave this window open; it updates by itself.");
      const settled = await waitForSettlement();
      if (settled) show(settled);
    }
  } catch (error) {
    $("error").textContent = error instanceof UserFacingError ? error.message : "Something went wrong. Nothing was paid.";
    if (!(error instanceof UserFacingError)) console.error(error);
    say("Your wallet signs one transfer for exactly this amount. It never grants standing access.");
  } finally {
    button.disabled = false;
  }
});

const charge = await load();
if (charge?.status === "open" && !hasEthereum()) {
  say("No Ethereum wallet was found in this browser. Install a wallet extension, or pay this from an x402 client using the address below.");
  $("pay").disabled = true;
  $("agent-note").open = true;
}
if (charge?.status === "settlement_pending") {
  const settled = await waitForSettlement();
  if (settled) show(settled);
}
