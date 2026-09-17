import { api, ethereumProof, solanaProof, UserFacingError } from "./wallets.js";

const $ = (id) => document.getElementById(id);
const errorBox = $("error");
const params = new URLSearchParams(location.search);
const signedQuery = params.has("sig") && params.has("client_id") ? location.search.slice(1) : null;

function showError(error) {
  errorBox.textContent = error instanceof UserFacingError ? error.message : "Something went wrong. Try again.";
  if (!(error instanceof UserFacingError)) console.error(error);
}

async function busy(button, label, run) {
  const original = button.textContent;
  errorBox.textContent = "";
  button.disabled = true;
  button.textContent = label;
  try {
    await run();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/**
 * After signing in: a product sign-in re-enters the original authorization request
 * (without the signature fields the provider added for this page), and the provider
 * sends the browser back to the product with a code. Otherwise, open the account page.
 */
function finish() {
  if (!signedQuery) return location.assign("/account");
  const resume = new URLSearchParams(signedQuery);
  for (const key of [...resume.keys()]) if (key === "sig" || key === "exp" || key.startsWith("ba_")) resume.delete(key);
  location.assign(`/api/auth/oauth2/authorize?${resume}`);
}

// Name the product the user is signing in to, when there is one.
if (signedQuery) {
  api("/api/auth/oauth2/public-client-prelogin", { body: { client_id: params.get("client_id"), oauth_query: signedQuery } })
    .then((client) => {
      if (!client?.client_name) return;
      const lede = $("lede");
      lede.textContent = "to continue to ";
      const name = document.createElement("strong");
      name.textContent = client.client_name;
      lede.append(name);
    })
    .catch(() => {});
}

$("ethereum").addEventListener("click", (event) =>
  busy(event.currentTarget, "Check your wallet", async () => {
    await api("/api/auth/siwe/verify", { body: await ethereumProof() });
    finish();
  }),
);

$("solana").addEventListener("click", (event) =>
  busy(event.currentTarget, "Check your wallet", async () => {
    await api("/api/auth/siws/verify", { body: await solanaProof() });
    finish();
  }),
);

let email = "";
$("email-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("email");
  if (!input.checkValidity()) return showError(new UserFacingError("Enter a valid email address."));
  busy($("send"), "Sending", async () => {
    email = input.value.trim();
    await api("/api/auth/email-otp/send-verification-otp", { body: { email, type: "sign-in" } });
    $("email-form").hidden = true;
    $("code-form").hidden = false;
    $("code-hint").textContent = `Sent to ${email}. It expires in 5 minutes.`;
    $("code").focus();
  });
});

$("code-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const otp = $("code").value.trim();
  if (!/^\d{6}$/.test(otp)) return showError(new UserFacingError("Enter the six digits from the email."));
  busy($("verify"), "Signing in", async () => {
    await api("/api/auth/sign-in/email-otp", { body: { email, otp } });
    finish();
  });
});

$("restart").addEventListener("click", () => {
  $("code-form").hidden = true;
  $("email-form").hidden = false;
  $("code").value = "";
  errorBox.textContent = "";
  $("email").focus();
});
