import { api, ethereumProof, solanaProof, UserFacingError } from "./wallets.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const usdc = (micro) => (micro / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const short = (address) => (address.length > 16 ? `${address.slice(0, 6)}...${address.slice(-6)}` : address);
const chainName = (wallet) => (wallet.chainFamily === "solana" ? "Solana" : "Ethereum");
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const products = { platform: "Top-up", plotform: "Plotform", cubicle: "Cubicle", floatlane: "Floatlane" };

function flash(kind, message) {
  $("error").textContent = kind === "error" ? message : "";
  $("ok").textContent = kind === "ok" ? message : "";
}

async function load() {
  const response = await fetch("/v1/me", { credentials: "same-origin" });
  if (response.status === 401) return location.replace("/sign-in");
  if (!response.ok) throw new UserFacingError("Your account could not be loaded. Refresh to try again.");
  const me = await response.json();

  $("name").textContent = me.user.email ?? (me.wallets[0] ? `${chainName(me.wallets[0])} ${short(me.wallets[0].address)}` : "Your account");
  const walletCount = `${me.wallets.length} ${me.wallets.length === 1 ? "wallet" : "wallets"} linked`;
  $("identity").textContent = me.user.email ? `Signs in with email · ${walletCount}` : `Signs in with a wallet · ${walletCount}`;

  const wallets = $("wallets");
  wallets.replaceChildren(
    ...(me.wallets.length
      ? me.wallets.map((wallet) =>
          el("li", {}, [
            el("span", { className: "chain", textContent: chainName(wallet) }),
            el("span", { className: "address", textContent: wallet.address, title: wallet.address }),
            wallet.chainFamily === "eip155" && wallet.chainId ? el("span", { className: "pill num", textContent: `chain ${wallet.chainId}` }) : el("span"),
          ]),
        )
      : [el("li", { className: "empty", textContent: "No wallets linked yet. Link one to sign in with it on any product." })]),
  );

  const credits = await Promise.all(me.organizations.map((org) => api(`/v1/orgs/${org.id}/credits`, { method: "GET" }).then((c) => ({ org, ...c }))));
  const personal = credits[0];
  if (personal) {
    $("balance-label").textContent = `${personal.org.name} balance`;
    $("balance").replaceChildren(document.createTextNode(usdc(personal.balanceMicro)), el("small", { textContent: "USDC" }));
  }
  $("orgs").replaceChildren(
    ...credits.slice(1).map(({ org, balanceMicro }) =>
      el("li", {}, [el("span", { textContent: org.name }), el("span", { className: "pill", textContent: org.role }), el("span", { className: "num", textContent: `${usdc(balanceMicro)} USDC` })]),
    ),
  );

  $("activity-scope").textContent = personal ? personal.org.name : "";
  const entries = personal?.entries ?? [];
  $("activity").replaceChildren(
    entries.length
      ? el("table", {}, [
          el("thead", {}, [el("tr", {}, [el("th", { textContent: "When" }), el("th", { textContent: "What" }), el("th", { className: "hide-sm", textContent: "Product" }), el("th", { className: "right", textContent: "Amount" }), el("th", { className: "right hide-sm", textContent: "Balance" })])]),
          el(
            "tbody",
            {},
            entries.map((entry) =>
              el("tr", {}, [
                el("td", { className: "num nowrap", textContent: when(entry.createdAt) }),
                el("td", { textContent: entry.kind === "grant" ? entry.reason : `${entry.description || entry.sku}${entry.units > 1 ? ` x ${entry.units}` : ""}` }),
                el("td", { className: "hide-sm", textContent: products[entry.service] ?? entry.service }),
                el("td", { className: `right num${entry.kind === "grant" ? " credit" : ""}`, textContent: `${entry.kind === "grant" ? "+" : "-"}${usdc(entry.amountMicro)}` }),
                el("td", { className: "right num hide-sm", textContent: usdc(entry.balanceAfterMicro) }),
              ]),
            ),
          ),
        ])
      : el("p", { className: "empty-block", textContent: "No credit activity yet. Top-ups and charges from any product appear here." }),
  );
  $("page").setAttribute("aria-busy", "false");
}

async function run(button, label, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  flash();
  try {
    await task();
  } catch (error) {
    flash("error", error instanceof UserFacingError ? error.message : "Something went wrong. Try again.");
    if (!(error instanceof UserFacingError)) console.error(error);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

$("link-ethereum").addEventListener("click", (event) =>
  run(event.currentTarget, "Check your wallet", async () => {
    const { address } = await api("/api/auth/siwe/link", { body: await ethereumProof() });
    await load();
    flash("ok", `Linked ${short(address)}. You can sign in with it on any product.`);
  }),
);
$("link-solana").addEventListener("click", (event) =>
  run(event.currentTarget, "Check your wallet", async () => {
    const { address } = await api("/api/auth/siws/link", { body: await solanaProof() });
    await load();
    flash("ok", `Linked ${short(address)}. You can sign in with it on any product.`);
  }),
);
$("sign-out").addEventListener("click", async () => {
  await fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin" });
  location.replace("/sign-in");
});

load().catch((error) => flash("error", error instanceof UserFacingError ? error.message : "Your account could not be loaded. Refresh to try again."));
