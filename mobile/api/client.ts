import { APIError } from "../apiErrors";

export const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://127.0.0.1:8000";

export async function request<T = any>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  if (!response.ok) {
    let detail: unknown;
    try { detail = (await response.json()).detail; } catch { detail = undefined; }
    throw new APIError(response.status, detail);
  }
  return (response.status === 204 ? null : response.json()) as Promise<T>;
}

export function uploadMultipart<T = any>(path: string, form: FormData): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}${path}`);
    xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) { try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("Invalid upload response")); } } else reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`)); };
    xhr.onerror = () => reject(new Error("Network error while uploading"));
    xhr.send(form);
  });
}
