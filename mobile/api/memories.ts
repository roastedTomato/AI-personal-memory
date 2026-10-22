import { request } from "./client";

export const listMemories = () => request("/memories");
export const searchMemories = (keyword: string) => request(`/memories?q=${encodeURIComponent(keyword)}`);
export const getMemory = (id: number) => request(`/memories/${id}`);
export const createMemory = (payload: unknown) => request("/memories", { method: "POST", body: JSON.stringify(payload) });
export const updateMemory = (id: number, payload: unknown) => request(`/memories/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const deleteMemory = (id: number) => request(`/memories/${id}`, { method: "DELETE" });
