import { API_URL } from "./client";
import * as FileSystem from "expo-file-system/legacy";
const cloudImages = process.env.EXPO_PUBLIC_STORAGE_BACKEND === "s3";
type Upload = { memory_id: number; upload_id: string; url: string; fields: Record<string, string> };

async function uploadStep<T>(operation: () => Promise<T>, stage: string, milliseconds = 30000, cancel?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${stage} timed out. No automatic retry was made; refresh saved state before trying again.`));
          cancel?.();
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type UploadProgress = (message: string) => void;
async function uploadS3(image: { uri: string; name: string; type: string }, id?: number, progress?: UploadProgress) {
  progress?.("Reading photo…");
  const file = await uploadStep(() => FileSystem.getInfoAsync(image.uri), "Reading the local photo");
  if (!file.exists || file.isDirectory) throw new Error("The selected photo could not be read.");
  if (file.size <= 0 || file.size > 10 * 1024 * 1024) throw new Error("Image must be between 1 byte and 10 MB");
  progress?.("Preparing upload…");
  const pending = await uploadStep(() => request<Upload>(id === undefined ? "/memories/image-uploads" : `/memories/${id}/image/uploads`, {
    method: "POST", body: JSON.stringify({ filename: image.name, content_type: image.type, size: file.size }),
  }), "Preparing the upload (authentication/API)");
  progress?.("Uploading photo…");
  let active = true;
  // Use Expo's native file upload task: no JS Blob/FormData serialization or
  // nested XHR file reads. FOREGROUND avoids iOS background-session retries.
  const task = FileSystem.createUploadTask(pending.url, image.uri, {
    httpMethod: "POST", uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
    fieldName: "file", mimeType: image.type, parameters: pending.fields,
  }, (event) => {
    if (active && event.totalBytesExpectedToSend > 0) progress?.(`Uploading photo… ${Math.round(event.totalBytesSent / event.totalBytesExpectedToSend * 100)}%`);
  });
  try {
    const result = await uploadStep(() => task.uploadAsync(), "S3 upload", 60000,
      () => { void task.cancelAsync().catch(() => undefined); });
    if (!result) throw new Error("S3 upload was cancelled. Upload has not been confirmed.");
    if (result.status < 200 || result.status >= 300) {
      const code = /<Code>\s*([A-Za-z][A-Za-z0-9]{0,79})\s*<\/Code>/.exec(result.body || "")?.[1];
      throw new Error(`S3 upload failed (HTTP ${result.status}${code ? `, ${code}` : ""}). Upload has not been confirmed.`);
    }
  } finally { active = false; }
  progress?.("Confirming upload…");
  return uploadStep(() => request(`/memories/${pending.memory_id}/image/uploads/complete`, {
    method: "POST", body: JSON.stringify({ upload_id: pending.upload_id }),
  }), "Confirming the uploaded photo");
}

export async function readMemoryImage(id: number): Promise<string> {
  const result = await request<{ url: string }>(`/memories/${id}/image/read`);
  return result.url.startsWith("/") ? API_URL + result.url : result.url;
}

import { uploadMultipart, request } from "./client";

export const uploadMemoryImage = (id: number, image: { uri: string; name: string; type: string }, progress?: UploadProgress) => { if (cloudImages) return uploadS3(image, id, progress); const form = new FormData(); form.append("image", image as any); return uploadMultipart(`/memories/${id}/image`, form); };
export const createMemoryFromImage = (image: { uri: string; name: string; type: string }, progress?: UploadProgress) => { if (cloudImages) return uploadS3(image, undefined, progress); const form = new FormData(); form.append("image", image as any); return uploadMultipart("/memories/from-image", form); };
export const imageRequest = <T = any>(path: string, options?: RequestInit) => request<T>(path, options);
