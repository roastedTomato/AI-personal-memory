import MemoryChat from "./MemoryChat";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { API_URL, createImageMemory, readMemoryImage, request, uploadMemoryImage } from "./api";
import type { Memory, VisionDraft, VisionEnvelope } from "./api";
import { getIdentityToken, restoreSession, signIn, signOut, sendEmailVerificationCode, confirmEmailVerification, register, confirmRegistration, resendRegistrationCode, requestPasswordReset, confirmPasswordReset } from "./auth";

import { documentFields, fieldLabels, readJson, memoryFields, reminderSuggestion, memorySaveRequest, filterMemories } from "./memoryFields";

type Draft = { title: string; original_text: string; category: string; tags: string };
const blankDraft: Draft = { title: "", original_text: "", category: "", tags: "" };
const dateLabel = (value: string) => new Intl.DateTimeFormat("en-NZ", { dateStyle: "medium" }).format(new Date(value));
const localDatePart = (value: string | null | undefined) => {
  if (!value) return "";
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const localTimePart = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : "";

function MemoryPhoto({ memory, large = false }: { memory: Memory; large?: boolean }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl(""); setFailed(false);
    if (memory.source_image_path) readMemoryImage(memory.id).then((value) => { if (active) setUrl(value); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [memory.id, memory.source_image_path]);
  if (!memory.source_image_path) return null;
  if (failed) return <p className="photo-error">Photo preview unavailable.</p>;
  if (!url) return <div className={`photo-placeholder${large ? " large" : ""}`} aria-label="Loading photo preview" />;
  return <a className={`photo-link${large ? " large" : ""}`} href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={`Open photo for ${memory.title}`}>
    <img src={url} alt={memory.source_image_filename || `Photo for ${memory.title}`} referrerPolicy="no-referrer" />
  </a>;
}

export default function App() {
  const [signedIn, setSignedIn] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup" | "confirm" | "forgot" | "reset">("signin");
  const [registrationCode, setRegistrationCode] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [detailMemory, setDetailMemory] = useState<Memory | null>(null);
  const [savedFields, setSavedFields] = useState<VisionDraft>(memoryFields());
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [ocrText, setOcrText] = useState("");
  const [ocrStarted, setOcrStarted] = useState(false);
  const [visionReview, setVisionReview] = useState<VisionEnvelope | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imagePendingConfirmation, setImagePendingConfirmation] = useState(false);
  const [ocrEditedAfterAnalysis, setOcrEditedAfterAnalysis] = useState(false);
  const [reminderDay, setReminderDay] = useState("");
  const [reminderTime, setReminderTime] = useState("");
  const [reminderBusy, setReminderBusy] = useState(false);

  const visibleMemories = filterMemories(memories, selectedTags);
  const tags = [...new Set(memories.flatMap((memory) => memory.tags))].sort();
  function resetEditor() {
    setEditingId(null); setEditingMemory(null); setDraft(blankDraft); setSavedFields(memoryFields());
    setVisionReview(null); setSelectedImage(null); setOcrText(""); setOcrStarted(false);
    setImagePendingConfirmation(false); setOcrEditedAfterAnalysis(false); setReminderDay(""); setReminderTime("");
  }
  function useReminderSuggestion() {
    const suggestion = reminderSuggestion(visionReview?.draft ?? savedFields);
    if (suggestion) { setReminderDay(suggestion.day); setReminderTime(suggestion.time); }
  }
  useEffect(() => {
    if (detailMemory) document.getElementById("memory-detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [detailMemory]);

  const loadMemories = useCallback(async (term = "") => {
    setBusy(true);
    try { setMemories(await request<Memory[]>(`/memories${term.trim() ? `?q=${encodeURIComponent(term.trim())}` : ""}`)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load your Memories."); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => {
    restoreSession().then((ok) => { setSignedIn(ok); if (ok) void loadMemories(); })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not restore your session."))
      .finally(() => setCheckingSession(false));
  }, [loadMemories]);

  async function handleSignIn(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (authMode === "forgot") {
        await requestPasswordReset(username.trim()); setAuthMode("reset"); setRegistrationCode("");
        setNotice("If your account can be recovered, a reset code will be sent to your email."); return;
      }
      if (authMode === "reset") {
        await confirmPasswordReset(username.trim(), registrationCode.trim(), password);
        setAuthMode("signin"); setPassword(""); setRegistrationCode(""); setNotice("Password reset. Sign in with your new password."); return;
      }
      if (authMode === "signup") {
        const confirmed = await register(username.trim(), password);
        setPassword(""); setAuthMode(confirmed ? "signin" : "confirm");
        setNotice(confirmed ? "Account created. Sign in to continue." : "Check your email for a verification code.");
        return;
      }
      if (authMode === "confirm") {
        await confirmRegistration(username.trim(), registrationCode.trim());
        setRegistrationCode(""); setAuthMode("signin"); setNotice("Email verified. Sign in to continue.");
        return;
      }
      await signIn(username.trim(), password); setPassword(""); setSignedIn(true); await loadMemories(); }
    catch (e) { setError(e instanceof Error ? e.message : "Sign-in failed."); }
    finally { setBusy(false); }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    if (!draft.title.trim()) { setError("Enter a title before saving."); setBusy(false); return; }
    if (imagePendingConfirmation && editingMemory?.source_image_path) {
      try {
        await request<Memory>(`/memories/${editingMemory.id}/image/finalize`, { method: "POST", body: JSON.stringify({
          title: draft.title.trim(), text: ocrText.trim(), source_image_path: editingMemory.source_image_path,
          draft_id: visionReview?.draft_id ?? null, draft: visionReview?.draft ?? null,
        }) });
        resetEditor(); setNotice("Photo details confirmed and saved."); await loadMemories(query);
      } catch (e) { setError(e instanceof Error ? e.message : "Could not confirm and save the photo details."); }
      finally { setBusy(false); }
      return;
    }
    const saveRequest = memorySaveRequest(editingMemory, draft.title, draft.original_text, draft.category,
      draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean), savedFields);
    try {
      const saved = await request<Memory>(saveRequest.path, { method: saveRequest.method, body: JSON.stringify(saveRequest.body) });
      setEditingId(saved.id); setEditingMemory(saved);
      const reminderChanged = Boolean(reminderDay || reminderTime) &&
        (reminderDay !== localDatePart(editingMemory?.reminder_at ?? null) || reminderTime !== localTimePart(editingMemory?.reminder_at ?? null));
      if (reminderChanged) {
        try {
          await persistEmailReminder(saved.id);
        } catch (e) {
          await loadMemories(query);
          setError(`Memory saved, but the email reminder was not saved: ${e instanceof Error ? e.message : "Please try again."}`);
          return;
        }
      }
      resetEditor(); setNotice(reminderChanged ? "Memory and email reminder saved." : "Memory saved."); await loadMemories(query);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save this Memory."); }
    finally { setBusy(false); }
  }

  function startEdit(memory: Memory) {
    if (busy || imageBusy || reminderBusy) return;
    setDetailMemory(null);
    setSavedFields(memoryFields(memory));
    setEditingId(memory.id);
    setEditingMemory(memory);
    setSelectedImage(null);
    const pending = readJson<VisionEnvelope>(memory.vision_draft);
    setVisionReview(pending);
    const recognized = readJson<{ text?: string }>(memory.image_text_draft);
    const recoveredText = pending?.reviewed_text ?? memory.confirmed_image_text ?? recognized?.text ?? memory.ocr_text ?? "";
    setOcrText(recoveredText);
    setDraft({ title: memory.title, original_text: memory.confirmation_status === "draft" || pending ? (memory.original_text || recoveredText) : (memory.confirmed_content || memory.original_text), category: memory.category ?? "", tags: memory.tags.join(", ") });
    setOcrStarted(Boolean(pending || recognized || memory.ocr_text || memory.confirmed_image_text));
    setImagePendingConfirmation(memory.confirmation_status === "draft" || Boolean(pending));
    setOcrEditedAfterAnalysis(false);
    setReminderDay(localDatePart(memory.reminder_at));
    setReminderTime(localTimePart(memory.reminder_at));
    setNotice(""); setError("");
    document.getElementById("memory-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function removeMemory(memory: Memory) {
    if (!window.confirm(`Delete “${memory.title}”? This cannot be undone.`)) return;
    setBusy(true); setError("");
    try { await request<null>(`/memories/${memory.id}`, { method: "DELETE" }); if (editingId === memory.id) resetEditor(); if (detailMemory?.id === memory.id) setDetailMemory(null); setNotice("Memory deleted."); await loadMemories(query); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not delete this Memory."); }
    finally { setBusy(false); }
  }

  async function runAutomaticImageRecognition(memory: Memory) {
    setImageBusy(true); setError(""); setNotice("Photo uploaded. Reading its text…"); setOcrStarted(true); setVisionReview(null);
    try {
      const ocr = await request<{ text?: string; status: string; error?: string | null }>(`/memories/${memory.id}/image/ocr`, { method: "POST" });
      const text = ocr.text ?? "";
      setOcrText(text); setDraft((current) => ({ ...current, original_text: text }));
      if (!text.trim()) {
        setError(`OCR did not find readable text (${ocr.error || ocr.status}). You can enter details manually before confirming.`);
        setNotice("");
        return;
      }
      setNotice("Text recognised. AI is extracting a title, summary, category, tags, and document fields…");
      const result = await request<{ vision: VisionEnvelope | null; metadata?: { status?: string; error?: string } }>(`/memories/${memory.id}/image/analyze-draft`, {
        method: "POST", body: JSON.stringify({ consent: true, text_confirmed: true, request_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, text }),
      });
      if (result.metadata?.status === "failed") throw new Error(`AI analysis failed (${result.metadata.error || "provider error"}). The OCR text and photo are preserved for review.`);
      if (!result.vision) throw new Error("The AI response did not contain a review draft. You can still confirm the OCR text manually.");
      setVisionReview(result.vision);
      setDraft((current) => ({ ...current, title: result.vision?.draft.suggested_title?.trim() || current.title || memory.title, original_text: result.vision?.reviewed_text || text, category: result.vision?.draft.category || "", tags: result.vision?.draft.tags.join(", ") || "" }));
      setNotice("AI suggestions are ready. Review and edit all fields, then confirm to save.");
      const fresh = await request<Memory>(`/memories/${memory.id}`); setEditingMemory(fresh); await loadMemories(query);
    } catch (e) { setError(e instanceof Error ? e.message : "Automatic recognition failed. The photo is preserved."); setNotice(""); }
    finally { setImageBusy(false); }
  }

  async function handlePhotoSelection(file: File | undefined, input: HTMLInputElement) {
    if (!file) return;
    const agreed = window.confirm("Automatically read this photo and extract its title and details? The image will be uploaded to your private storage; OCR text will be sent to OpenAI for suggestions, which may incur a cost. Nothing becomes confirmed until you review and click Confirm and save.");
    if (!agreed) { input.value = ""; setSelectedImage(null); return; }
    setSelectedImage(file); setImageBusy(true); setError(""); setNotice("Uploading photo…"); setVisionReview(null); setOcrText(""); setOcrStarted(false);
    const titleFromFile = file.name.replace(/\.[^.]+$/, "").trim() || "Image Memory";
    try {
      let memory: Memory;
      if (editingId === null) {
        memory = await createImageMemory(file);
      } else if (editingMemory) {
        await uploadMemoryImage(editingMemory.id, file);
        memory = await request<Memory>(`/memories/${editingMemory.id}`);
      } else {
        throw new Error("Open a Memory before replacing its photo.");
      }
      const title = draft.title.trim() || titleFromFile;
      setEditingId(memory.id); setEditingMemory(memory); setImagePendingConfirmation(true);
      setDraft((current) => ({ ...current, title, original_text: editingId === null ? "" : current.original_text }));
      setSelectedImage(null); input.value = "";
      await runAutomaticImageRecognition(memory);
    } catch (e) { setSelectedImage(null); input.value = ""; setError(e instanceof Error ? e.message : "Photo upload failed."); setNotice(""); }
    finally { setImageBusy(false); }
  }

  async function analyzeImageText() {
    if (!editingMemory || !ocrText.trim()) return;
    if (!window.confirm("Send the edited OCR text to OpenAI again to refresh the suggestions? This may incur a cost.")) return;
    setImageBusy(true); setError(""); setNotice("");
    try {
      const result = await request<{ vision: VisionEnvelope | null; metadata?: { status?: string; error?: string } }>(`/memories/${editingMemory.id}/image/analyze-draft`, {
        method: "POST", body: JSON.stringify({ consent: true, text_confirmed: true, request_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, text: ocrText.trim() }),
      });
      if (result.metadata?.status === "failed") throw new Error(`AI analysis failed (${result.metadata.error || "provider error"}). The photo and OCR text remain saved.`);
      if (!result.vision) throw new Error("The AI response did not contain a review draft.");
      setVisionReview(result.vision);
      setDraft((current) => ({ ...current, category: result.vision?.draft.category || "", tags: result.vision?.draft.tags.join(", ") || "" }));
      setNotice("AI draft ready. Check every field and confirm to save.");
      setOcrEditedAfterAnalysis(false);
      const fresh = await request<Memory>(`/memories/${editingMemory.id}`); setEditingMemory(fresh); await loadMemories(query);
    } catch (e) { setError(e instanceof Error ? e.message : "AI analysis failed. The photo and OCR text remain saved."); }
    finally { setImageBusy(false); }
  }

  function updateVisionDraft<K extends keyof VisionDraft>(key: K, value: VisionDraft[K]) {
    setVisionReview((current) => current ? { ...current, draft: { ...current.draft, [key]: value } } : current);
  }

  async function persistEmailReminder(memoryId: number): Promise<Memory> {
    if (!reminderDay || !reminderTime) throw new Error("Choose both a reminder date and time.");
    const due = new Date(`${reminderDay}T${reminderTime}:00`);
    if (!Number.isFinite(due.getTime()) || due <= new Date()) throw new Error("Choose a valid future date and time.");
    await request(`/memories/${memoryId}/reminder/email`, { method: "PUT", body: JSON.stringify({
      reminder_at: due.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      identity_token: await getIdentityToken(),
    }) });
    const fresh = await request<Memory>(`/memories/${memoryId}`);
    if (fresh.reminder_delivery !== "email" || !fresh.reminder_at || new Date(fresh.reminder_at).getTime() !== due.getTime()) {
      throw new Error("The server did not confirm the saved reminder. Refresh and try again.");
    }
    return fresh;
  }

  async function saveEmailReminder() {
    if (!editingMemory || !reminderDay || !reminderTime) { setError("Choose both a reminder date and time."); return; }
    const localDate = new Date(`${reminderDay}T${reminderTime}:00`);
    if (!Number.isFinite(localDate.getTime()) || localDate <= new Date()) { setError("Choose a valid future date and time."); return; }
    if (editingMemory.reminder_at && editingMemory.reminder_delivery === "local" && !window.confirm("This Memory already has a reminder saved by the mobile app. Replacing it with email may not cancel the notification already scheduled on that phone. Continue?")) return;
    setReminderBusy(true); setError(""); setNotice("");
    try {
      const fresh = await persistEmailReminder(editingMemory.id);
      setEditingMemory(fresh); setReminderDay(localDatePart(fresh.reminder_at)); setReminderTime(localTimePart(fresh.reminder_at));
      setNotice("Email reminder scheduled."); await loadMemories(query);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not schedule the email reminder."); }
    finally { setReminderBusy(false); }
  }

  async function cancelEmailReminder() {
    if (!editingMemory || editingMemory.reminder_delivery !== "email") return;
    setReminderBusy(true); setError(""); setNotice("");
    try {
      await request<null>(`/memories/${editingMemory.id}/reminder`, { method: "DELETE" });
      const fresh = await request<Memory>(`/memories/${editingMemory.id}`);
      setEditingMemory(fresh); setReminderDay(""); setReminderTime(""); setNotice("Email reminder cancelled."); await loadMemories(query);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not cancel the email reminder."); }
    finally { setReminderBusy(false); }
  }

  async function handleSignOut() {
    await signOut(); setSignedIn(false); setMemories([]); resetEditor(); setDetailMemory(null); setSelectedTags([]); setQuery(""); setNotice(""); setError("");
  }

  if (checkingSession) return <main className="center-shell"><div className="spinner" aria-label="Checking session" /></main>;
  if (!signedIn) return <main className="auth-shell">
    <section className="auth-card">
      <div className="brand-mark">M</div>
      <p className="eyebrow">YOUR PRIVATE LIBRARY</p>
      <h1>Keep important things close.</h1>
      <p className="muted">{authMode === "signup" ? "Create an account with your email address." : authMode === "confirm" ? "Verify your email using the code we sent." : "Sign in to access your saved documents and notes."}</p>
      {(authMode === "forgot" || authMode === "reset") && <p className="muted">{authMode === "forgot" ? "Enter your account email to reset your password." : "Enter your email code and a new password."}</p>}
      <form onSubmit={handleSignIn} className="form-stack">
        <label>Email or username<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        {(authMode === "signin" || authMode === "signup" || authMode === "reset") && <label>Password<input type="password" autoComplete={authMode !== "signin" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>}
        {(authMode === "signup" || authMode === "reset") && <p className="muted small-copy">Use at least 12 characters, including uppercase, lowercase, numbers and symbols.</p>}
        {(authMode === "confirm" || authMode === "reset") && <label>Verification code<input autoComplete="one-time-code" value={registrationCode} onChange={(e) => setRegistrationCode(e.target.value)} required /></label>}
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <button className="primary-button" disabled={busy}>{busy ? "Please wait…" : authMode === "signup" ? "Create account" : authMode === "confirm" ? "Verify email" : authMode === "forgot" ? "Send reset code" : authMode === "reset" ? "Reset password" : "Sign in securely"}</button>
        {authMode === "confirm" && <button type="button" className="quiet-button" disabled={busy} onClick={async () => {
          setBusy(true); setError("");
          try { await resendRegistrationCode(username.trim()); setNotice("A new verification code was sent."); }
          catch (e) { setError(e instanceof Error ? e.message : "Could not resend code."); }
          finally { setBusy(false); }
        }}>Resend verification code</button>}
        <button type="button" className="quiet-button" disabled={busy} onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setPassword(""); setError(""); setNotice(""); }}>{authMode === "signin" ? "Create an account" : "Back to sign in"}</button>
        {authMode === "signin" && <button type="button" className="quiet-button" disabled={busy} onClick={() => { setAuthMode("forgot"); setPassword(""); setError(""); setNotice(""); }}>Forgot password?</button>}
        {authMode === "reset" && <button type="button" className="quiet-button" disabled={busy} onClick={() => { setAuthMode("forgot"); setPassword(""); setError(""); }}>Request another reset code</button>}
        {authMode === "signin" && <button type="button" className="quiet-button" disabled={busy} onClick={() => { setAuthMode("confirm"); setError(""); setNotice(""); }}>Verify an existing account</button>}
      </form>
      <p className="privacy-note">Your password is sent directly to Amazon Cognito and is never saved by this app.</p>
    </section>
  </main>;

  return <div className="app-shell">
    <header className="topbar"><a className="wordmark" href="#top"><span className="brand-mark small">M</span> Personal Memory</a><div className="topbar-right"><span className="connection"><i /> Connected</span><button className="quiet-button" onClick={() => void handleSignOut()}>Sign out</button></div></header>
    <main className="workspace" id="top">
      <div className="page-heading"><div><p className="eyebrow">YOUR PERSONAL LIBRARY</p><h1>Memories</h1><p className="muted">A calm place for the details you want to keep.</p></div><span className="count-pill">{memories.length} saved</span></div>
      {error && <div className="banner error-banner" role="alert">{error}</div>}
      {notice && <div className="banner success-banner" role="status">{notice}</div>}
      <MemoryChat onOpenMemory={async (id) => { setDetailMemory(await request<Memory>(`/memories/${id}`)); }} />
      {detailMemory && <section id="memory-detail" className="detail-panel" aria-label="Memory details">
        <button className="quiet-button" onClick={() => setDetailMemory(null)}>Close details</button>
        <h2>{detailMemory.title}</h2><p className="category">{detailMemory.category} · {detailMemory.confirmation_status}</p>
        <h3>{detailMemory.confirmation_status === "draft" ? "Draft — review before saving" : "Summary"}</h3><p className="memory-copy">{detailMemory.confirmed_content || "No confirmed summary."}</p>
        <dl className="detail-fields">{documentFields.map((key) => { const value = memoryFields(detailMemory)[key]; return value ? <div key={key}><dt>{fieldLabels[key]}</dt><dd>{value}</dd></div> : null; })}</dl>
        <div className="tags">{detailMemory.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
        {detailMemory.reminder_at && <p>{detailMemory.reminder_delivery === "email" ? "Email reminder" : "Mobile reminder"}: {new Date(detailMemory.reminder_at).toLocaleString("en-NZ")} · {detailMemory.reminder_delivery_status}</p>}
        <details><summary>Original source text</summary><p className="memory-copy">{detailMemory.original_text || detailMemory.confirmed_image_text || detailMemory.ocr_text || "No source text."}</p></details>
        <MemoryPhoto memory={detailMemory} large />
        <button className="secondary-button" onClick={() => startEdit(detailMemory)}>Edit Memory</button>
      </section>}
      <div className="columns">
        <section className="library-panel">
          <form className="search" onSubmit={(e) => { e.preventDefault(); void loadMemories(query); }}><span aria-hidden="true">⌕</span><input aria-label="Search Memories" placeholder="Search your library" value={query} onChange={(e) => setQuery(e.target.value)} /><button type="submit" disabled={busy}>Search</button></form>
          <div className="tag-filters" aria-label="Filter by tags">{tags.map((tag) => <button key={tag} type="button" aria-pressed={selectedTags.includes(tag)} onClick={() => setSelectedTags((current) => current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag])}>{tag}</button>)}{selectedTags.length > 0 && <button onClick={() => setSelectedTags([])}>Clear filters</button>}</div>
          {memories.length > 0 && visibleMemories.length === 0 && <p role="status">No Memories match these tags.</p>}
          {busy && memories.length === 0 ? <div className="empty">Loading your library…</div> : memories.length === 0 ? <div className="empty"><div className="empty-icon">✳</div><h2>Your library is ready</h2><p>Add a note or document detail using the form.</p></div> : <div className="memory-list">{visibleMemories.map((memory) => <article className="memory-card" key={memory.id}>
            <div className="memory-icon">{(memory.category || "M").slice(0, 1).toUpperCase()}</div><div className="memory-main"><div className="memory-title-row"><h2>{memory.title}</h2><span className="date">{dateLabel(memory.created_at)}</span></div>{memory.category && <p className="category">{memory.category}</p>}<p className="memory-copy">{memory.confirmed_content || memory.original_text}</p>{memory.reminder_at && <p className="reminder-note">{memory.reminder_delivery === "email" ? "Email reminder" : "Mobile reminder"}: {new Date(memory.reminder_at).toLocaleString("en-NZ")}{memory.reminder_delivery_status ? ` · ${memory.reminder_delivery_status}` : ""}</p>}{memory.source_image_path && <MemoryPhoto memory={memory} />} {memory.tags.length > 0 && <div className="tags">{memory.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}<div className="card-actions"><button disabled={busy || imageBusy || reminderBusy} onClick={async () => { try { setDetailMemory(await request<Memory>(`/memories/${memory.id}`)); } catch (e) { setError(e instanceof Error ? e.message : "Could not open Memory."); } }}>View details</button><button disabled={busy || imageBusy || reminderBusy} onClick={() => startEdit(memory)}>Edit</button><button disabled={busy || imageBusy || reminderBusy} className="delete-link" onClick={() => void removeMemory(memory)}>Delete</button></div></div>
          </article>)}</div>}
        </section>
        <aside className="editor-panel" id="memory-form"><p className="eyebrow">MANUAL ENTRY</p><h2>{editingId === null ? "Add a Memory" : "Edit Memory"}</h2><p className="muted small-copy">Manual saving works without AI.</p>
          <form className="form-stack" onSubmit={handleSave} onInvalidCapture={() => setError("Please complete the required Title and Details fields before saving.")}>
            <label>Title<input maxLength={200} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Power bill — November" required /></label>
            <label>{imagePendingConfirmation ? "Recognised text — review and correct" : "Details"}<textarea rows={6} value={draft.original_text} onChange={(e) => { setDraft({ ...draft, original_text: e.target.value }); if (imagePendingConfirmation) { setOcrText(e.target.value); if (visionReview) setOcrEditedAfterAnalysis(true); } }} placeholder="Write the details you want to remember" required /></label>
            <label>Category{imagePendingConfirmation ? <select value={draft.category} onChange={(e) => { setDraft({ ...draft, category: e.target.value }); if (visionReview) updateVisionDraft("category", (e.target.value || null) as VisionDraft["category"]); }}><option value="">Unclassified</option>{["bill", "receipt", "notice", "event", "appointment", "travel", "other"].map((category) => <option key={category} value={category}>{category}</option>)}</select> : <input maxLength={100} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="Bill, receipt, notice…" />}</label>
            <label>Tags<input value={draft.tags} onChange={(e) => { setDraft({ ...draft, tags: e.target.value }); if (visionReview) updateVisionDraft("tags", e.target.value.split(",").map((tag) => tag.trim()).filter(Boolean)); }} placeholder="Separate tags with commas" /></label>
            <label>Photo (JPEG, PNG, or WebP; up to 10 MB)<input type="file" accept="image/jpeg,image/png,image/webp" disabled={imageBusy || busy || reminderBusy} onChange={(e) => { const input = e.currentTarget; void handlePhotoSelection(input.files?.[0], input); }} /></label>
            <label className="camera-entry">Take a photo<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={imageBusy || busy} onChange={(e) => { const input = e.currentTarget; void handlePhotoSelection(input.files?.[0], input); }} /></label>
            {!imagePendingConfirmation && <fieldset className="structured-editor"><legend>Document fields</legend><div className="vision-fields">
              {documentFields.filter((key) => editingMemory?.source_image_path || ["amount", "currency", "date", "due_date", "location_name"].includes(key)).map((key) => <label key={key}>{fieldLabels[key]}<input type={key === "date" || key === "due_date" ? "date" : key === "time" ? "time" : "text"} maxLength={key === "currency" ? 3 : undefined} value={savedFields[key] ?? ""} onChange={(e) => setSavedFields((current) => ({ ...current, [key]: e.target.value || null }))} /></label>)}
            </div></fieldset>}
            {selectedImage && <p className="photo-selected">Selected: {selectedImage.name}</p>}
            {editingMemory?.source_image_path && !selectedImage && <div className="editor-photo"><p>Current photo</p><MemoryPhoto memory={editingMemory} large /></div>}
            {editingMemory?.source_image_path && <section className="ai-review-section">
              <h3>AI image review</h3>
              {!ocrStarted && !visionReview && editingMemory?.confirmation_status !== "draft" && <><p className="muted small-copy">Select a photo to automatically run OCR and prepare an AI draft.</p><button type="button" className="secondary-button" disabled={busy || imageBusy} onClick={() => { if (window.confirm("Re-run OCR on this photo and send the recognised text to OpenAI for suggestions? This may incur a cost.")) { setImagePendingConfirmation(true); void runAutomaticImageRecognition(editingMemory!); } }}>{imageBusy ? "Reading photo…" : "Re-run OCR and AI"}</button></>}
              {ocrStarted && <><p className="muted small-copy">OCR text is shown in the Details field above. Correct it there; refresh AI suggestions if you make changes.</p>{ocrEditedAfterAnalysis && visionReview && <button type="button" className="secondary-button" disabled={imageBusy || !ocrText.trim()} onClick={() => void analyzeImageText()}>Refresh suggestions from edited text</button>}{!visionReview && ocrText.trim() && <button type="button" className="secondary-button" disabled={imageBusy} onClick={() => void analyzeImageText()}>Analyse OCR text with AI</button>}</>}
              {visionReview && <div className="vision-draft"><h4>AI suggestions · review required</h4>
                <label>Summary<textarea rows={4} value={visionReview.draft.summary ?? ""} onChange={(e) => updateVisionDraft("summary", e.target.value || null)} /></label>
                <div className="vision-fields">
                  {documentFields.map((key) => <label key={key}>{fieldLabels[key]}<input type={key === "date" || key === "due_date" ? "date" : key === "time" ? "time" : "text"} maxLength={key === "currency" ? 3 : undefined} value={visionReview.draft[key] ?? ""} onChange={(e) => updateVisionDraft(key, e.target.value || null)} /></label>)}
                </div>
                {visionReview.draft.suggested_title && <button type="button" className="quiet-button" onClick={() => setDraft((current) => ({ ...current, title: visionReview.draft.suggested_title || current.title }))}>Use suggested title: {visionReview.draft.suggested_title}</button>}
                {visionReview.draft.uncertain_fields.length > 0 && <p className="review-warning">Check uncertain fields: {visionReview.draft.uncertain_fields.join(", ")}</p>}
                {visionReview.draft.warnings.map((warning, index) => <p className="review-warning" key={index}>{warning}</p>)}
                <p className="muted small-copy">The OCR text and AI suggestions are drafts. Review all fields, then confirm below.</p>
              </div>}
            </section>}
            {editingId !== null && editingMemory && !imagePendingConfirmation && editingMemory.confirmation_status !== "draft" && <section className="email-reminder-section">
              <h3>Email reminder</h3>
              {!editingMemory.reminder_at && reminderSuggestion(savedFields) && <button type="button" className="quiet-button" onClick={useReminderSuggestion}>Use document date as reminder suggestion</button>}
              {error.includes("verified Cognito email") && <button type="button" disabled={reminderBusy} onClick={async () => {
                setReminderBusy(true);
                try {
                  await sendEmailVerificationCode();
                  const code = window.prompt("Enter the verification code sent to your Cognito account email:");
                  if (!code?.trim()) { setNotice("Verification code sent. Click Verify account email again when ready."); return; }
                  await confirmEmailVerification(code.trim());
                  setError(""); setNotice("Account email verified. You can now save your email reminder.");
                } catch (e) { setError(e instanceof Error ? e.message : "Email verification failed."); }
                finally { setReminderBusy(false); }
              }}>Verify account email</button>}
              {reminderBusy && <p role="status">Saving email reminder…</p>}
              {error && <p className="error" role="alert">{error}</p>}
              {notice && <p role="status">{notice}</p>}
              {editingMemory.reminder_at && <p className="muted small-copy">Current: {new Date(editingMemory.reminder_at).toLocaleString("en-NZ")} · {editingMemory.reminder_delivery === "email" ? `Email (${editingMemory.reminder_delivery_status || "scheduled"})` : "Mobile notification"}</p>}
              <label>Date<input type="date" value={reminderDay} onChange={(e) => setReminderDay(e.target.value)} /></label>
              <label>Time<input type="time" value={reminderTime} onChange={(e) => setReminderTime(e.target.value)} /></label>
              <div className="review-actions"><button type="button" className="secondary-button" disabled={reminderBusy || !reminderDay || !reminderTime} onClick={() => void saveEmailReminder()}>{reminderBusy ? "Saving…" : editingMemory.reminder_delivery === "email" ? "Update email reminder" : "Schedule email reminder"}</button>{editingMemory.reminder_delivery === "email" && <button type="button" className="quiet-button" disabled={reminderBusy} onClick={() => void cancelEmailReminder()}>Cancel reminder</button>}</div>
              <p className="muted small-copy">Sent to the verified email address on your Cognito account.</p>
            </section>}
            {error && <p className="error" role="alert">{error}</p>}
            {notice && <p role="status">{notice}</p>}
            <button className="primary-button" disabled={busy || imageBusy || reminderBusy}>{busy ? "Saving…" : imagePendingConfirmation ? "Confirm and save" : editingId === null ? "Save Memory" : "Save changes"}</button>
            {editingId !== null && <button type="button" className="quiet-button cancel-button" disabled={busy || imageBusy || reminderBusy} onClick={resetEditor}>Cancel edit</button>}
          </form>
        </aside>
      </div>
      <footer className="footer">Connected to your private account{API_URL ? <span> · AWS API</span> : null}</footer>
    </main>
  </div>;
}
