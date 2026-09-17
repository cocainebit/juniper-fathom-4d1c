import { api, UserFacingError } from "./wallets.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const oauthQuery = location.search.slice(1);
const described = { openid: "Know who you are", profile: "See your name", email: "See your email address", offline_access: "Stay signed in to it" };

$("scopes").replaceChildren(
  ...(params.get("scope") ?? "").split(" ").filter(Boolean).map((scope) => {
    const item = document.createElement("li");
    item.style.gridTemplateColumns = "1fr";
    item.textContent = described[scope] ?? scope;
    return item;
  }),
);

api("/api/auth/oauth2/public-client-prelogin", { body: { client_id: params.get("client_id"), oauth_query: oauthQuery } })
  .then((client) => {
    if (client?.client_name) $("lede").textContent = `${client.client_name} wants to use your account.`;
  })
  .catch(() => {});

async function decide(accept) {
  $("error").textContent = "";
  try {
    const result = await api("/api/auth/oauth2/consent", { body: { accept, oauth_query: oauthQuery } });
    if (result?.url) location.assign(result.url);
  } catch (error) {
    $("error").textContent = error instanceof UserFacingError ? error.message : "Something went wrong. Try again.";
  }
}
$("allow").addEventListener("click", () => decide(true));
$("deny").addEventListener("click", () => decide(false));
