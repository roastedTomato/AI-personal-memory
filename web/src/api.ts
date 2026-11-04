import { getAccessToken } from "./auth";

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "");

export type Memory = {
  id: number;
  title: string;
  original_text: string;
  confirmed_content: string;
  category: string | null;
  tags: string[];
  event_date: string | null;
  due_date: string | null;
  location: string | null;
  amount: number | string | null;
  currency: string | null;
  confirmation_status: string;
  source_type: string;
  created_at: string;
  updated_at: string;
};

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!API_URL) throw new Error("VITE_API_URL is missing. Copy .env.example to .env.local and set the deployed API URL.");
  const token = await getAccessToken();
  if (!token) throw new Error("Your session has ended. Sign in again.");
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      const detail = body.detail;
      message = typeof detail === "string" ? detail : detail?.message || message;
    } catch { /* Keep the status-based message. */ }
    throw new Error(message);
  }
  return (response.status === 204 ? null : response.json()) as Promise<T>;
}
