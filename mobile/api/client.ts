import { authorizationHeaders } from "./auth";
import { APIError } from "../apiErrors";

export const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://127.0.0.1:8000";

export async function request<T = any>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...options, headers: { "Content-Type": "application/json", ...options?.headers, ...await authorizationHeaders() } });
  if (!response.ok) {
    let detail: unknown;
    try { detail = (await response.json()).detail; } catch { detail = undefined; }
    throw new APIError(response.status, detail);
  }
  return (response.status === 204 ? null : response.json()) as Promise<T>;
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
