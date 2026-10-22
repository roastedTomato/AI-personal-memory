import { uploadMultipart, request } from "./client";

export const uploadMemoryImage = (id: number, image: { uri: string; name: string; type: string }) => { const form = new FormData(); form.append("image", image as any); return uploadMultipart(`/memories/${id}/image`, form); };
export const createMemoryFromImage = (image: { uri: string; name: string; type: string }) => { const form = new FormData(); form.append("image", image as any); return uploadMultipart("/memories/from-image", form); };
export const imageRequest = <T = any>(path: string, options?: RequestInit) => request<T>(path, options);
