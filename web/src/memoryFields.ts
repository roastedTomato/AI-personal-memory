import type { Memory, VisionDraft } from "./api";

export const documentFields = ["amount", "currency", "date", "time", "due_date", "institution", "location_name", "location_address", "location_purpose"] as const;
export const fieldLabels = { amount: "Amount", currency: "Currency", date: "Date", time: "Time", due_date: "Due date", institution: "Institution", location_name: "Location", location_address: "Address", location_purpose: "Purpose" };
export function readJson<T>(value: string | null | undefined): T | null {
  try { return value ? JSON.parse(value) as T : null; } catch { return null; }
}
export function memoryFields(memory?: Memory | null): VisionDraft {
  const raw = readJson<unknown>(memory?.confirmed_vision);
  const stored = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const fields: VisionDraft = {
    suggested_title: null, summary: memory?.confirmed_content || null, category: memory?.category ?? null,
    tags: memory?.tags ?? [], amount: memory?.amount == null ? null : String(memory.amount),
    currency: memory?.currency ?? null, date: memory?.event_date ?? null, time: null,
    due_date: memory?.due_date ?? null, institution: null, location_name: memory?.location ?? null,
    location_address: null, location_purpose: null, uncertain_fields: [], warnings: [],
  };
  for (const key of documentFields) {
    const value = stored[key];
    if (value === null || typeof value === "string") fields[key] = value;
  }
  for (const key of ["uncertain_fields", "warnings"] as const) {
    const value = stored[key];
    if (Array.isArray(value)) fields[key] = value.filter((item): item is string => typeof item === "string");
  }
  return fields;
}

export function reminderSuggestion(fields: VisionDraft, now = new Date()) {
  const uncertain = new Set(fields.uncertain_fields);
  for (const key of ["due_date", "date"] as const) {
    const day = fields[key];
    if (!day || uncertain.has(key) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const parsed = new Date(`${day}T12:00:00`);
    if (!Number.isFinite(parsed.getTime()) || parsed.getFullYear() !== Number(day.slice(0, 4)) || parsed.getMonth() + 1 !== Number(day.slice(5, 7)) || parsed.getDate() !== Number(day.slice(8, 10))) continue;
    // An event's time is not evidence of a separate bill due time.
    const time = !uncertain.has("time") && (key === "date" || day === fields.date) ? fields.time || "" : "";
    const date = new Date(`${day}T${time || "23:59"}:00`);
    if (Number.isFinite(date.getTime()) && date > now) return { day, time };
  }
  return null;
}
export function availableTags(memories: Memory[], selected: string[] = []) {
  const values = new Map<string, string>();
  for (const value of [...selected, ...memories.flatMap((memory) => memory.tags)]) {
    const tag = value.trim();
    if (tag && !values.has(tag.toLowerCase())) values.set(tag.toLowerCase(), tag);
  }
  return [...values.values()].sort((a, b) => a.localeCompare(b));
}
export function structuredPayload(fields: VisionDraft) {
  return { amount: fields.amount || null, currency: fields.currency?.trim().toUpperCase() || null,
    event_date: fields.date || null, due_date: fields.due_date || null, location: fields.location_name || null };
}
export function filterMemories(memories: Memory[], tags: string[]) {
  return memories.filter((memory) => tags.every((tag) => memory.tags.some((value) => value.trim().toLowerCase() === tag.trim().toLowerCase())));
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
