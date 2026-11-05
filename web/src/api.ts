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
  source_image_path?: string | null;
  source_image_filename?: string | null;
  source_image_mime_type?: string | null;
  source_image_size?: number | null;
  ocr_text?: string | null;
  ocr_status?: string | null;
  image_text_draft?: string | null;
  confirmed_image_text?: string | null;
  vision_draft?: string | null;
  confirmed_vision?: string | null;
  created_at: string;
  updated_at: string;
  reminder_at?: string | null;
  reminder_delivery?: string;
  reminder_delivery_status?: string | null;
  reminder_sent_at?: string | null;
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

export type VisionDraft = {
  suggested_title?: string | null;
  summary: string | null;
  category: string | null;
  tags: string[];
  amount: string | null;
  currency: string | null;
  date: string | null;
  time: string | null;
  due_date: string | null;
  institution: string | null;
  location_name: string | null;
  location_address: string | null;
  location_purpose: string | null;
  uncertain_fields: string[];
  warnings: string[];
};

export type VisionEnvelope = { draft_id: string; reviewed_text?: string; draft: VisionDraft };

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function uploadMemoryImage(memoryId: number, file: File): Promise<void> {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES) throw new Error("Images must be 10 MB or smaller.");
  const pending = await request<{ upload_id: string; url: string; fields: Record<string, string> }>(
    `/memories/${memoryId}/image/uploads`,
    { method: "POST", body: JSON.stringify({ filename: file.name, content_type: file.type, size: file.size }) },
  );
  const form = new FormData();
  for (const [key, value] of Object.entries(pending.fields)) form.append(key, value);
  form.append("file", file);
  const response = await fetch(pending.url, { method: "POST", body: form });
  if (!response.ok) throw new Error(`Image upload failed (${response.status}). Check the file and try again.`);
  await request(`/memories/${memoryId}/image/uploads/complete`, {
    method: "POST",
    body: JSON.stringify({ upload_id: pending.upload_id }),
  });
}

export async function createImageMemory(file: File): Promise<Memory> {
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES) throw new Error("Images must be 10 MB or smaller.");
  const pending = await request<{ memory_id: number; upload_id: string; url: string; fields: Record<string, string> }>(
    "/memories/image-uploads",
    { method: "POST", body: JSON.stringify({ filename: file.name, content_type: file.type, size: file.size }) },
  );
  const form = new FormData();
  for (const [key, value] of Object.entries(pending.fields)) form.append(key, value);
  form.append("file", file);
  const response = await fetch(pending.url, { method: "POST", body: form });
  if (!response.ok) throw new Error(`Image upload failed (${response.status}). Check the file and try again.`);
  return request<Memory>(`/memories/${pending.memory_id}/image/uploads/complete`, {
    method: "POST", body: JSON.stringify({ upload_id: pending.upload_id }),
  });
}

export async function readMemoryImage(memoryId: number): Promise<string> {
  const result = await request<{ url: string }>(`/memories/${memoryId}/image/read`);
  return result.url;
}
