import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { request } from "./api";
import { questionPayload, readAnswer } from "./chat";
import type { MemorySource, QueryAnswer } from "./chat";

type Message = { role: "user" | "assistant"; text: string; sources?: MemorySource[] };

export default function MemoryChat({ onOpenMemory }: { onOpenMemory: (id: number) => Promise<void> }) {
  const [question, setQuestion] = useState("");
  const [consent, setConsent] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [openingSource, setOpeningSource] = useState(false);
  const previous = useRef<QueryAnswer | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);
  useEffect(() => { if (messages.length) end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages]);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!consent || inFlight.current) return;
    let payload;
    try { payload = questionPayload(question, previous.current); }
    catch (e) { setError(e instanceof Error ? e.message : "Enter a question."); return; }
    const controller = new AbortController();
    inFlight.current = controller; setBusy(true); setError("");
    setMessages((current) => current.at(-1)?.role === "user" && current.at(-1)?.text === payload.question
      ? current : [...current, { role: "user", text: payload.question }]);
    try {
      const result = readAnswer(await request<unknown>("/memories/query", {
        method: "POST", body: JSON.stringify(payload),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
      }));
      if (controller.signal.aborted) return;
      previous.current = result;
      setMessages((current) => [...current, { role: "assistant", text: result.answer, sources: result.sources }]);
      setQuestion("");
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Unable to answer. Please try again.");
    } finally {
      if (!controller.signal.aborted) { inFlight.current = null; setBusy(false); }
    }
  }

  async function openSource(id: number) {
    setOpeningSource(true); setError("");
    try { await onOpenMemory(id); }
    catch (e) { setError(e instanceof Error ? e.message : "This Memory is no longer available."); }
    finally { setOpeningSource(false); }
  }

  return <section className="chat-panel" aria-labelledby="chat-title">
    <div className="chat-heading"><div><p className="eyebrow">ASK YOUR MEMORIES</p><h2 id="chat-title">Ask your Memories</h2></div>
      <button type="button" className="quiet-button" disabled={busy || openingSource} onClick={() => { previous.current = null; setMessages([]); setQuestion(""); setError(""); }}>New conversation</button>
    </div>
    <p className="muted small-copy">Ask about your confirmed documents, bills and events. Open a source to check the answer.</p>
    <div className="chat-messages" role="log" aria-label="Memory conversation" aria-live="polite">
      {!messages.length && <p className="muted">Try “What is my next event in Hamilton?” or “Which bills are due this month?”</p>}
      {messages.map((message, index) => <article key={index} className={`chat-message ${message.role}`}>
        <strong>{message.role === "user" ? "You" : "Personal Memory"}</strong><p>{message.text}</p>
        {!!message.sources?.length && <div className="chat-sources" aria-label="Answer sources">{message.sources.map((source) => <button key={source.memory_id} type="button" disabled={openingSource} onClick={() => void openSource(source.memory_id)}>
          [Memory {source.memory_id}] {source.title}{source.event_date ? ` · ${source.event_date}` : ""}
        </button>)}</div>}
      </article>)}
      {busy && <p role="status">Searching your Memories…</p>}<div ref={end} />
    </div>
    <form className="chat-form" onSubmit={ask}>
      <label htmlFor="memory-question">Your question</label>
      <textarea id="memory-question" rows={2} maxLength={1000} required value={question} disabled={busy} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a question about your saved Memories…" />
      <label className="chat-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={(e) => setConsent(e.target.checked)} />I agree to send my question, clarification replies and matching confirmed Memories to OpenAI. This may incur an AI usage cost.</label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary-button" disabled={busy || !consent || !question.trim()}>{busy ? "Thinking…" : "Ask"}</button>
    </form>
  </section>;
}
