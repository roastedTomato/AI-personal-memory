import type { Memory, VisionDraft } from "./api";

export const documentFields = ["amount", "currency", "date", "time", "due_date", "institution", "location_name", "location_address", "location_purpose"] as const;
export const fieldLabels = { amount: "Amount", currency: "Currency", date: "Date", time: "Time", due_date: "Due date", institution: "Institution", location_name: "Location", location_address: "Address", location_purpose: "Purpose" };
export function readJson<T>(value: string | null | undefined): T | null {
  try { return value ? JSON.parse(value) as T : null; } catch { return null; }
}
export function memoryFields(memory?: Memory | null): VisionDraft {
  const stored = readJson<Partial<VisionDraft>>(memory?.confirmed_vision);
  return {
    suggested_title: null, summary: memory?.confirmed_content || null, category: memory?.category ?? null,
    tags: memory?.tags ?? [], amount: memory?.amount == null ? null : String(memory.amount),
    currency: memory?.currency ?? null, date: memory?.event_date ?? null, time: null,
    due_date: memory?.due_date ?? null, institution: null, location_name: memory?.location ?? null,
    location_address: null, location_purpose: null, uncertain_fields: [], warnings: [], ...stored,
  };
}
export function reminderSuggestion(fields: VisionDraft, now = new Date()) {
  const day = fields.due_date || fields.date;
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  // A missing time stays empty so accepting a date never schedules an invented time.
  const time = fields.time || "";
  const date = new Date(`${day}T${time || "23:59"}:00`);
  return Number.isFinite(date.getTime()) && date > now ? { day, time } : null;
}
export function structuredPayload(fields: VisionDraft) {
  return { amount: fields.amount || null, currency: fields.currency?.trim().toUpperCase() || null,
    event_date: fields.date || null, due_date: fields.due_date || null, location: fields.location_name || null };
}
export function filterMemories(memories: Memory[], tags: string[]) {
  return memories.filter((memory) => tags.every((tag) => memory.tags.some((value) => value.toLowerCase() === tag.toLowerCase())));
}

export function memorySaveRequest(memory: Memory | null, title: string, details: string, category: string, tags: string[], fields: VisionDraft) {
  const confirmedContent = memory && details.trim() === memory.original_text ? memory.confirmed_content : details.trim();
  const common = { title: title.trim(), confirmed_content: confirmedContent, category: category.trim() || null, tags };
  if (memory?.source_image_path) {
    return { path: `/memories/${memory.id}/image/confirmed`, method: "PATCH", body: {
      title: common.title, confirmed_content: confirmedContent,
      draft: { ...fields, currency: fields.currency?.trim().toUpperCase() || null, summary: confirmedContent.length <= 2000 ? confirmedContent : null, category: common.category, tags },
    } };
  }
  return { path: memory ? `/memories/${memory.id}` : "/memories", method: memory ? "PATCH" : "POST", body: {
    ...structuredPayload(fields), ...common, original_text: details.trim(),
  } };
}
