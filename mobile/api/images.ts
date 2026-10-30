import { API_URL } from "./client";
const cloudImages = process.env.EXPO_PUBLIC_STORAGE_BACKEND === "s3";
type Upload = { memory_id: number; upload_id: string; url: string; fields: Record<string, string> };

async function uploadS3(image: { uri: string; name: string; type: string }, id?: number) {
  const bytes = await (await fetch(image.uri)).blob();
  if (bytes.size <= 0 || bytes.size > 10 * 1024 * 1024) throw new Error("Image must be between 1 byte and 10 MB");
  const pending = await request<Upload>(id === undefined ? "/memories/image-uploads" : `/memories/${id}/image/uploads`, {
    method: "POST", body: JSON.stringify({ filename: image.name, content_type: image.type, size: bytes.size }),
  });
  const form = new FormData();
  Object.entries(pending.fields).forEach(([key, value]) => form.append(key, value));
  form.append("file", image as any);
  // Send only the signed form to S3; never forward the Cognito bearer token.
  const uploaded = await fetch(pending.url, { method: "POST", body: form });
  if (!uploaded.ok) throw new Error("Image upload failed. The original has not been confirmed.");
  return request(`/memories/${pending.memory_id}/image/uploads/complete`, {
    method: "POST", body: JSON.stringify({ upload_id: pending.upload_id }),
  });
}

export async function readMemoryImage(id: number): Promise<string> {
  const result = await request<{ url: string }>(`/memories/${id}/image/read`);
  return result.url.startsWith("/") ? API_URL + result.url : result.url;
}

import { uploadMultipart, request } from "./client";

export const uploadMemoryImage = (id: number, image: { uri: string; name: string; type: string }) => { if (cloudImages) return uploadS3(image, id); const form = new FormData(); form.append("image", image as any); return uploadMultipart(`/memories/${id}/image`, form); };
export const createMemoryFromImage = (image: { uri: string; name: string; type: string }) => { if (cloudImages) return uploadS3(image); const form = new FormData(); form.append("image", image as any); return uploadMultipart("/memories/from-image", form); };
export const imageRequest = <T = any>(path: string, options?: RequestInit) => request<T>(path, options);
