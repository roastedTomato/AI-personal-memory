// The Cognito sign-in flow installs a provider; tokens are never put in URLs.
import * as SecureStore from "expo-secure-store";

let tokenProvider: (() => Promise<string | null>) | null = null;
let cachedToken: string | null = null;
export function setAccessTokenProvider(provider: (() => Promise<string | null>) | null) {
  tokenProvider = provider;
  cachedToken = null;
}
export async function authorizationHeaders(): Promise<Record<string, string>> {
  cachedToken = tokenProvider ? await tokenProvider() : null;
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