const region = import.meta.env.VITE_COGNITO_REGION as string | undefined;
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
const endpoint = region ? `https://cognito-idp.${region}.amazonaws.com/` : null;
const REFRESH_KEY = "apm.web.refresh-token";

type AuthTokens = { AccessToken: string; IdToken?: string; RefreshToken?: string; ExpiresIn?: number };
let accessToken: string | null = null;
let identityToken: string | null = null;
let expiresAt = 0;
let refreshInFlight: Promise<string | null> | null = null;

function config() {
  if (!endpoint || !clientId) throw new Error("Cognito web configuration is missing. Set the VITE_COGNITO variables and restart the web app.");
  return { endpoint, clientId };
}

async function cognitoCall(target: string, body: Record<string, unknown>): Promise<AuthTokens> {
  const { endpoint: url } = config();
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
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
  identityToken = tokens.IdToken ?? null;
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

export async function getIdentityToken(): Promise<string> {
  await getAccessToken();
  if (!identityToken) throw new Error("Cognito did not provide an identity token. Sign out and sign in again.");
  return identityToken;
}

async function emailAttributeCall(target: string, extra: Record<string, string> = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error("Sign in again to verify your email.");
  const { endpoint: url } = config();
  const response = await fetch(url, {
    method: "POST", signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify({ AccessToken: token, AttributeName: "email", ...extra }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || "Email verification failed.");
}

export async function sendEmailVerificationCode() {
  await emailAttributeCall("GetUserAttributeVerificationCode");
}

export async function confirmEmailVerification(code: string) {
  await emailAttributeCall("VerifyUserAttribute", { Code: code });
  expiresAt = 0;
  await getAccessToken();
}

export async function signOut() {
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
  accessToken = null;
  identityToken = null;
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

async function registrationCall(target: string, body: Record<string, unknown>) {
  const { endpoint: url, clientId: appClient } = config();
  const response = await fetch(url, {
    method: "POST", signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify({ ClientId: appClient, ...body }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || "The account request could not be completed.") as Error & { code?: string };
    error.code = String(payload.__type || "").split("#").pop();
    throw error;
  }
  return payload;
}
export async function register(email: string, password: string): Promise<boolean> {
  const result = await registrationCall("SignUp", { Username: email, Password: password, UserAttributes: [{ Name: "email", Value: email }] });
  return result.UserConfirmed === true;
}
export async function confirmRegistration(email: string, code: string) {
  await registrationCall("ConfirmSignUp", { Username: email, ConfirmationCode: code });
}
export async function resendRegistrationCode(email: string) {
  await registrationCall("ResendConfirmationCode", { Username: email });
}

export function validateResetPassword(password: string, confirmation: string): string | null {
  if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9\s]/.test(password)) {
    return "Use at least 12 characters, including uppercase, lowercase, numbers and symbols.";
  }
  if (password !== confirmation) return "The passwords do not match.";
  return null;
}

function recoveryError(error: unknown): Error {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  const messages: Record<string, string> = {
    CodeMismatchException: "The verification code is incorrect. Check the email and try again.",
    ExpiredCodeException: "The reset code has expired. Request a new code.",
    InvalidPasswordException: "Your password does not meet the account password requirements.",
    PasswordHistoryPolicyViolationException: "Choose a password you have not used recently.",
    LimitExceededException: "Too many attempts. Please wait before trying again.",
    TooManyRequestsException: "Too many requests. Please wait before trying again.",
    CodeDeliveryFailureException: "The reset email could not be delivered. Please try again later.",
    UserNotFoundException: "The reset could not be completed. Check your account email and request a new code.",
  };
  if (typeof code === "string" && messages[code]) return new Error(messages[code]);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return new Error("The request timed out. Please try again.");
  if (error instanceof TypeError) return new Error("Could not connect. Check your internet connection and try again.");
  return error instanceof Error ? error : new Error("Password recovery could not be completed.");
}

export async function requestPasswordReset(username: string) {
  if (!username.trim()) throw new Error("Enter your account email or username.");
  try { await registrationCall("ForgotPassword", { Username: username.trim() }); }
  catch (error) {
    // Keep the same request-code screen for accounts that do not exist.
    if (error instanceof Error && "code" in error && error.code === "UserNotFoundException") return;
    throw recoveryError(error);
  }
}

export async function confirmPasswordReset(username: string, code: string, password: string) {
  if (!username.trim() || !code.trim()) throw new Error("Enter your account email and verification code.");
  const validation = validateResetPassword(password, password);
  if (validation) throw new Error(validation);
  try { await registrationCall("ConfirmForgotPassword", { Username: username.trim(), ConfirmationCode: code.trim(), Password: password }); }
  catch (error) { throw recoveryError(error); }
}
