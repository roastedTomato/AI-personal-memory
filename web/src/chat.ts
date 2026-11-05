export type MemorySource = { memory_id: number; title: string; event_date: string | null };
export type QueryAnswer = { conversation_id?: string; status: string; answer: string; sources: MemorySource[] };

export function questionPayload(question: string, previous: QueryAnswer | null, today = new Date()) {
  const text = question.trim();
  if (!text || text.length > 1000) throw new Error("Enter a question of up to 1,000 characters.");
  return {
    question: text, consent: true,
    today: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`,
    conversation_id: previous?.conversation_id ?? null,
    is_clarification_reply: previous?.status === "needs_clarification",
  };
}

export function readAnswer(value: unknown): QueryAnswer {
  if (!value || typeof value !== "object") throw new Error("The server returned an invalid answer. Please try again.");
  const answer = value as QueryAnswer;
  if (typeof answer.answer !== "string" || typeof answer.status !== "string" || !Array.isArray(answer.sources)) {
    throw new Error("The server returned an invalid answer. Please try again.");
  }
  return { ...answer, sources: answer.sources.filter((source) => source && Number.isInteger(source.memory_id) && typeof source.title === "string") };
}
