import { authorizationHeaders } from "./auth";
import { APIError } from "../apiErrors";

export const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://127.0.0.1:8000";

export async function request<T = any>(path: string, options?: RequestInit): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const externalSignal = options?.signal;
  const abort = () => controller.abort();
  externalSignal?.addEventListener("abort", abort);
  if (externalSignal?.aborted) controller.abort();
  try {
  return await Promise.race([ (async () => {
  const headers = await authorizationHeaders();
  if (controller.signal.aborted) throw new Error("Request was cancelled or timed out. No automatic retry was made.");
  const response = await fetch(`${API_URL}${path}`, { ...options, signal: controller.signal, headers: { "Content-Type": "application/json", ...options?.headers, ...headers } });
  if (!response.ok) {
    let detail: unknown;
    try { detail = (await response.json()).detail; } catch { detail = undefined; }
    throw new APIError(response.status, detail);
  }
  return (response.status === 204 ? null : response.json()) as Promise<T>;
  })(), new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Request timed out. No automatic retry was made; refresh saved state before trying again."));
      controller.abort();
    }, 35000);
  }) ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  }
}

export async function uploadMultipart<T = any>(path: string, form: FormData): Promise<T> {
  const headers = await authorizationHeaders();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}${path}`);
    Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("Invalid upload response")); } } else reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`)); };
    xhr.onerror = () => reject(new Error("Network error while uploading"));
    xhr.send(form);
  });
}
