import type { Auth } from "./auth.js";
import { OPERATOR_HEADER } from "./auth.js";

const OPERATOR_EMAIL = "operator@platform.invalid";

/**
 * Runs an OAuth administration call as the operator: a dedicated user with a
 * short-lived session, plus the in-process operator secret. The session is
 * deleted afterwards.
 */
export async function asOperator<T>(auth: Auth, run: (headers: Headers) => Promise<T>): Promise<T> {
  const context = await auth.$context;
  const user =
    (await context.internalAdapter.findUserByEmail(OPERATOR_EMAIL))?.user ??
    (await context.internalAdapter.createUser({ name: "Platform operator", email: OPERATOR_EMAIL, emailVerified: false }, { method: "operator" } as never));
  const session = await context.internalAdapter.createSession(user.id);
  try {
    return await run(new Headers({ authorization: `Bearer ${session.token}`, [OPERATOR_HEADER]: auth.operatorSecret }));
  } finally {
    await context.internalAdapter.deleteSession(session.token);
  }
}

const isLoopbackHttp = (uri: string) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(uri);

export type TrustedClient = { client_id: string; client_secret: string };

/** Registers a first-party product as a trusted confidential client (no consent screen) and links it to its API resource. */
export async function registerTrustedClient(auth: Auth, input: { name: string; redirectUris: string[]; resource?: string }): Promise<TrustedClient> {
  return asOperator(auth, async (headers) => {
    const client = (await auth.api.adminCreateOAuthClient({
      headers,
      body: {
        client_name: input.name,
        redirect_uris: input.redirectUris,
        skip_consent: true,
        token_endpoint_auth_method: "client_secret_post",
        // OAuth 2.1 allows plain-http redirects only to loopback addresses, which the
        // provider files under "native". Deployed products use https and "web".
        application_type: input.redirectUris.every(isLoopbackHttp) ? "native" : "web",
      },
    })) as TrustedClient;
    if (input.resource) {
      await auth.api.adminLinkClientResource({ headers, params: { identifier: input.resource, client_id: client.client_id } } as never);
    }
    return client;
  });
}
