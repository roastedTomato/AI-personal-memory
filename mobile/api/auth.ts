// The Cognito sign-in flow installs a provider; tokens are never put in URLs.
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
