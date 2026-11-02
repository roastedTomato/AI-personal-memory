// The Cognito sign-in flow installs a provider; tokens are never put in URLs.
import * as SecureStore from "expo-secure-store";

let tokenProvider: (() => Promise<string | null>) | null = null;
let cachedToken: string | null = null;
let accessTokenExpiresAt = 0;
let refreshing: Promise<string | null> | null = null;
let sessionVersion = 0;

const cognitoRegion = process.env.EXPO_PUBLIC_COGNITO_REGION;
const cognitoClientId = process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID;
const cognitoEndpoint = cognitoRegion ? `https://cognito-idp.${cognitoRegion}.amazonaws.com/` : null;

type CognitoTokens = { AccessToken: string; IdToken?: string; RefreshToken?: string; ExpiresIn?: number };

function requireCognitoConfig(): { endpoint: string; clientId: string } {
  if (!cognitoEndpoint || !cognitoClientId) throw new Error("Cognito is not configured");
  return { endpoint: cognitoEndpoint, clientId: cognitoClientId };
}

function setAccessToken(token: string, expiresIn = 3600): void {
  cachedToken = token;
  accessTokenExpiresAt = Date.now() + Math.max(30, expiresIn - 30) * 1000;
}

async function cognitoRequest(target: string, body: Record<string, unknown>): Promise<CognitoTokens> {
  const { endpoint } = requireCognitoConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error("Sign-in or session refresh was rejected. Check your account and credentials.");
      Object.assign(error, { status: response.status });
      throw error;
    }
    if (!payload.AuthenticationResult?.AccessToken) throw new Error("Cognito did not return an access token");
    return payload.AuthenticationResult as CognitoTokens;
  } finally { clearTimeout(timer); }
}

export async function signIn(username: string, password: string): Promise<void> {
  const version = ++sessionVersion;
  const { clientId } = requireCognitoConfig();
  const result = await cognitoRequest("InitiateAuth", { AuthFlow: "USER_PASSWORD_AUTH", ClientId: clientId, AuthParameters: { USERNAME: username, PASSWORD: password } });
  if (version !== sessionVersion) throw new Error("Sign-in was cancelled.");
  if (result.RefreshToken) await saveRefreshToken(result.RefreshToken);
  if (version !== sessionVersion) throw new Error("Sign-in was cancelled.");
  setAccessToken(result.AccessToken, result.ExpiresIn);
}

export async function refreshAccessToken(): Promise<string | null> {
  if (cachedToken && Date.now() < accessTokenExpiresAt) return cachedToken;
  if (refreshing) return refreshing;
  const pending = refreshSession(sessionVersion);
  refreshing = pending;
  try { return await pending; } finally { if (refreshing === pending) refreshing = null; }
}

async function refreshSession(version: number): Promise<string | null> {
  const refreshToken = await readRefreshToken();
  if (!refreshToken || version !== sessionVersion) return null;
  const { clientId } = requireCognitoConfig();
  try {
    const result = await cognitoRequest("InitiateAuth", { AuthFlow: "REFRESH_TOKEN_AUTH", ClientId: clientId, AuthParameters: { REFRESH_TOKEN: refreshToken } });
    if (version !== sessionVersion) return null;
    setAccessToken(result.AccessToken, result.ExpiresIn);
    return result.AccessToken;
  } catch (error) {
    if (version !== sessionVersion) return null;
    // A temporary network failure must not destroy the persisted session.
    if (!(error instanceof Error && 'status' in error && error.status === 400)) throw error;
    await clearRefreshToken();
    cachedToken = null;
    accessTokenExpiresAt = 0;
    return null;
  }
}

export async function signOut(): Promise<void> {
  ++sessionVersion;
  cachedToken = null;
  accessTokenExpiresAt = 0;
  refreshing = null;
  const refreshToken = await readRefreshToken();
  await clearRefreshToken();
  if (refreshToken && cognitoEndpoint && cognitoClientId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      await fetch(cognitoEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSCognitoIdentityProviderService.RevokeToken" },
        body: JSON.stringify({ ClientId: cognitoClientId, Token: refreshToken }),
        signal: controller.signal,
      }).catch(() => undefined);
    } finally { clearTimeout(timer); }
  }
}
export function setAccessTokenProvider(provider: (() => Promise<string | null>) | null) {
  tokenProvider = provider;
  cachedToken = null;
}
export async function authorizationHeaders(): Promise<Record<string, string>> {
  if (tokenProvider && (!cachedToken || Date.now() >= accessTokenExpiresAt)) cachedToken = await tokenProvider();
  if ((!cachedToken || Date.now() >= accessTokenExpiresAt) && process.env.EXPO_PUBLIC_APP_ENV === "cloud") await refreshAccessToken();
  if (process.env.EXPO_PUBLIC_APP_ENV === "cloud" && !cachedToken) throw new Error("Sign in is required");
  return cachedToken ? { Authorization: `Bearer ${cachedToken}` } : {};
}
export function imageAuthorizationHeaders(): Record<string, string> {
  return cachedToken ? { Authorization: `Bearer ${cachedToken}` } : {};
}

const REFRESH_TOKEN_KEY = "memory.cognito.refresh-token";

export async function saveRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function readRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function clearRefreshToken(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}
