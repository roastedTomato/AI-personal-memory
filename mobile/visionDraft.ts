export type VisionDraft = {
  suggested_title?: string | null; summary: string | null; category: string | null; tags: string[];
  amount: string | null; currency: string | null; date: string | null;
  time: string | null; due_date: string | null; institution: string | null;
  location_name: string | null; location_address: string | null; location_purpose: string | null;
  uncertain_fields: string[]; warnings: string[];
};
export type VisionEnvelope = { draft_id: string; reviewed_text?: string; draft: VisionDraft };
export type VisionFieldKey = keyof Omit<VisionDraft, "suggested_title" | "uncertain_fields" | "warnings">;
export const visionKeys: VisionFieldKey[] = ["summary", "category", "tags", "amount", "currency", "date", "time", "due_date", "institution", "location_name", "location_address", "location_purpose"];

// The API returns { vision: { draft_id, draft: { ...fields } } }; Memory detail stores vision as JSON.
export function mapVisionEnvelope(input: unknown): VisionEnvelope | null {
  if (!input || typeof input !== "object") return null;
  const envelope = input as Record<string, unknown>;
  if (typeof envelope.draft_id !== "string" || !envelope.draft || typeof envelope.draft !== "object") return null;
  const source = envelope.draft as Record<string, unknown>;
  const draft = {} as VisionDraft;
  for (const key of visionKeys) {
    const value = source[key];
    if (key === "tags") draft.tags = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    else (draft as unknown as Record<string, unknown>)[key] = typeof value === "string" ? value : null;
  }
  draft.uncertain_fields = Array.isArray(source.uncertain_fields) ? source.uncertain_fields.filter((item): item is string => typeof item === "string") : [];
  draft.warnings = Array.isArray(source.warnings) ? source.warnings.filter((item): item is string => typeof item === "string") : [];
  draft.suggested_title = typeof source.suggested_title === "string" ? source.suggested_title : null;
  return { draft_id: envelope.draft_id, reviewed_text: typeof envelope.reviewed_text === "string" ? envelope.reviewed_text : undefined, draft };
}

export function visibleVisionFields(draft: VisionDraft): VisionFieldKey[] {
  return visionKeys.filter((key) => key === "tags" ? draft.tags.length > 0 : !!draft[key]?.trim());
}

export function reminderSuggestion(draft: VisionDraft): { day: string; time: string | null } | null {
  // A suggestion is form data, not a scheduled reminder; past dates remain visible for review.
  const day = [draft.date, draft.due_date].find((value) => value && /^\d{4}-\d{2}-\d{2}$/.test(value));
  return day ? { day, time: draft.time ?? null } : null;
}

export function suggestReminderIfUntouched(draft: VisionDraft, existingReminderAt: string | null | undefined, touched: boolean) {
  return existingReminderAt || touched ? null : reminderSuggestion(draft);
}

export function emptyVisionDraft(): VisionDraft {
  return { suggested_title: null, summary: null, category: null, tags: [], amount: null, currency: null, date: null, time: null, due_date: null, institution: null, location_name: null, location_address: null, location_purpose: null, uncertain_fields: [], warnings: [] };
}

export function categoryFields(category: string | null): VisionFieldKey[] {
  const name = (category || "").toLowerCase();
  if (/账单|发票|收据|费用|支付|bill|invoice|receipt|expense|payment/.test(name)) return ["summary", "category", "tags", "amount", "currency", "date", "due_date", "institution"];
  if (/预约|活动|会议|行程|旅行|event|meeting|appointment|travel|booking/.test(name)) return ["summary", "category", "tags", "date", "time", "location_name", "location_address"];
  if (/地点|场所|地址|location|place|address/.test(name)) return ["summary", "category", "tags", "location_name", "location_address", "location_purpose"];
  return ["summary", "category", "tags"];
}
