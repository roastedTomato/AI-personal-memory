const region = import.meta.env.VITE_COGNITO_REGION as string | undefined;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
const endpoint = region ? `https://cognito-idp.${region}.amazonaws.com/` : null;
const REFRESH_KEY = "apm.web.refresh-token";

type AuthTokens = { AccessToken: string; RefreshToken?: string; ExpiresIn?: number };
let accessToken: string | null = null;
let expiresAt = 0;
let refreshInFlight: Promise<string | null> | null = null;

function config() {
  if (!endpoint || !clientId) throw new Error("Cognito web configuration is missing. Set the VITE_COGNITO variables and restart the web app.");
  return { endpoint, clientId };
}

async function cognitoCall(target: string, body: Record<string, unknown>): Promise<AuthTokens> {
  const { endpoint: url } = config();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || "Cognito rejected the sign-in or session refresh.") as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  const result = payload.AuthenticationResult as AuthTokens | undefined;
  if (!result?.AccessToken) throw new Error("Cognito returned an unsupported sign-in challenge. Check whether the account requires MFA or a password reset.");
  return result;
}

function applyTokens(tokens: AuthTokens) {
  accessToken = tokens.AccessToken;
  expiresAt = Date.now() + Math.max(30, (tokens.ExpiresIn ?? 3600) - 30) * 1000;
  if (tokens.RefreshToken) sessionStorage.setItem(REFRESH_KEY, tokens.RefreshToken);
}

export async function signIn(username: string, password: string) {
  const { clientId: appClient } = config();
  const tokens = await cognitoCall("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH", ClientId: appClient,
    AuthParameters: { USERNAME: username, PASSWORD: password },
  });
  applyTokens(tokens);
}

export async function getAccessToken(): Promise<string | null> {
  if (accessToken && Date.now() < expiresAt) return accessToken;
  if (refreshInFlight) return refreshInFlight;
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return null;
  const pending = (async () => {
    const { clientId: appClient } = config();
    try {
      const tokens = await cognitoCall("InitiateAuth", { AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: appClient, AuthParameters: { REFRESH_TOKEN: refreshToken } });
      applyTokens(tokens);
      return accessToken;
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 400) {
        sessionStorage.removeItem(REFRESH_KEY);
        accessToken = null;
        expiresAt = 0;
        return null;
      }
      throw error;
    }
  })();
  refreshInFlight = pending;
  try { return await pending; } finally { if (refreshInFlight === pending) refreshInFlight = null; }
}

export async function signOut() {
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
  accessToken = null;
  expiresAt = 0;
  if (!refreshToken || !endpoint || !clientId) return;
  await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSCognitoIdentityProviderService.RevokeToken" },
    body: JSON.stringify({ ClientId: clientId, Token: refreshToken }),
  }).catch(() => undefined);
}

export async function restoreSession(): Promise<boolean> {
  return Boolean(await getAccessToken());
}
