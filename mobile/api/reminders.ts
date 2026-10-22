import { request } from "./client";

export const saveReminder = (id: number, reminder_at: string) => request(`/memories/${id}/reminder`, { method: "PUT", body: JSON.stringify({ reminder_at }) });
export const removeReminder = (id: number) => request(`/memories/${id}/reminder`, { method: "DELETE" });
