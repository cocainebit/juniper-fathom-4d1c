// Wallet sign-in helpers shared by the sign-in and account pages.
// No libraries: messages are built to the EIP-4361 and Sign In With Solana text formats.

export class UserFacingError extends Error {}

export async function api(path, { method = "POST", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || (response.status === 429 ? "Too many attempts. Wait a minute and try again." : "Something went wrong. Try again.");
    throw new UserFacingError(message);
  }
  return data;
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const toHex = (text) => "0x" + [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function fromBase58(text) {
  let bytes = [0];
  for (const char of text) {
    let carry = B58.indexOf(char);
    if (carry < 0) throw new Error("invalid base58");
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

const rejected = (error) => error?.code === 4001 || /reject|denied|cancel/i.test(String(error?.message));

// ---- Ethereum ----

export function hasEthereum() {
  return typeof window.ethereum?.request === "function";
}

/** Asks the wallet to sign a SIWE message for this server. Returns { message, signature }. */
export async function ethereumProof() {
  if (!hasEthereum()) throw new UserFacingError("No Ethereum wallet was found in this browser. Install a wallet extension, or continue with email.");
  try {
    const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
    const chainId = parseInt(await window.ethereum.request({ method: "eth_chainId" }), 16);
    const { nonce } = await api("/api/auth/siwe/nonce", { body: {} });
    const now = new Date();
    const message = [
      `${location.host} wants you to sign in with your Ethereum account:`,
      address,
      "",
      "Sign in to your account.",
      "",
      `URI: ${location.origin}`,
      "Version: 1",
      `Chain ID: ${chainId}`,
      `Nonce: ${nonce}`,
      `Issued At: ${now.toISOString()}`,
      `Expiration Time: ${new Date(now.getTime() + 5 * 60 * 1000).toISOString()}`,
    ].join("\n");
    const signature = await window.ethereum.request({ method: "personal_sign", params: [toHex(message), address] });
    return { message, signature };
  } catch (error) {
    if (error instanceof UserFacingError) throw error;
    if (rejected(error)) throw new UserFacingError("The wallet request was cancelled.");
    throw new UserFacingError("The wallet could not sign in. Unlock it and try again.");
  }
}

// ---- Solana ----

function solanaProvider() {
  return window.phantom?.solana ?? window.backpack ?? window.solflare ?? window.solana ?? null;
}

export function hasSolana() {
  return Boolean(solanaProvider());
}

function signInText(input) {
  let message = `${input.domain} wants you to sign in with your Solana account:\n${input.address}`;
  if (input.statement) message += `\n\n${input.statement}`;
  const fields = [];
  if (input.uri) fields.push(`URI: ${input.uri}`);
  if (input.version) fields.push(`Version: ${input.version}`);
  if (input.chainId) fields.push(`Chain ID: ${input.chainId}`);
  if (input.nonce) fields.push(`Nonce: ${input.nonce}`);
  if (input.issuedAt) fields.push(`Issued At: ${input.issuedAt}`);
  if (input.expirationTime) fields.push(`Expiration Time: ${input.expirationTime}`);
  if (fields.length) message += `\n\n${fields.join("\n")}`;
  return message;
}

const keyBytes = (key) => (typeof key === "string" ? fromBase58(key) : typeof key?.toBytes === "function" ? key.toBytes() : new Uint8Array(key));

/** Signs the server's sign-in input with the Solana wallet. Returns the body for /siws/verify or /siws/link. */
export async function solanaProof() {
  const provider = solanaProvider();
  if (!provider) throw new UserFacingError("No Solana wallet was found in this browser. Install a wallet extension, or continue with email.");
  try {
    const { input } = await api("/api/auth/siws/input", { body: {} });
    let publicKey, signedMessage, signature;
    if (typeof provider.signIn === "function") {
      const output = await provider.signIn(input);
      publicKey = keyBytes(output.account?.publicKey ?? output.publicKey ?? output.address);
      signedMessage = output.signedMessage;
      signature = output.signature;
    } else {
      const connected = await provider.connect();
      const key = connected?.publicKey ?? provider.publicKey;
      publicKey = keyBytes(key);
      const address = typeof key === "string" ? key : key.toBase58();
      signedMessage = new TextEncoder().encode(signInText({ ...input, address }));
      ({ signature } = await provider.signMessage(signedMessage, "utf8"));
    }
    return { nonce: input.nonce, publicKey: toBase64(publicKey), signedMessage: toBase64(signedMessage), signature: toBase64(signature) };
  } catch (error) {
    if (error instanceof UserFacingError) throw error;
    if (rejected(error)) throw new UserFacingError("The wallet request was cancelled.");
    throw new UserFacingError("The wallet could not sign in. Unlock it and try again.");
  }
}
