import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { API_URL, request } from "./api";
import type { Memory } from "./api";
import { restoreSession, signIn, signOut } from "./auth";

type Draft = { title: string; original_text: string; category: string; tags: string };
const blankDraft: Draft = { title: "", original_text: "", category: "", tags: "" };
const dateLabel = (value: string) => new Intl.DateTimeFormat("en-NZ", { dateStyle: "medium" }).format(new Date(value));

export default function App() {
  const [signedIn, setSignedIn] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadMemories = useCallback(async (term = "") => {
    setBusy(true); setError("");
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
    try { await signIn(username.trim(), password); setPassword(""); setSignedIn(true); await loadMemories(); }
    catch (e) { setError(e instanceof Error ? e.message : "Sign-in failed."); }
    finally { setBusy(false); }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    const body = { title: draft.title.trim(), original_text: draft.original_text.trim(), confirmed_content: editingMemory && draft.original_text.trim() === editingMemory.original_text ? editingMemory.confirmed_content : draft.original_text.trim(), category: draft.category.trim() || null, tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean) };
    try {
      if (editingId === null) await request<Memory>("/memories", { method: "POST", body: JSON.stringify(body) });
      else await request<Memory>(`/memories/${editingId}`, { method: "PATCH", body: JSON.stringify(body) });
      setDraft(blankDraft); setEditingId(null); setEditingMemory(null); setNotice("Memory saved."); await loadMemories(query);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save this Memory."); }
    finally { setBusy(false); }
  }

  function startEdit(memory: Memory) {
    setEditingId(memory.id);
    setEditingMemory(memory);
    setDraft({ title: memory.title, original_text: memory.original_text, category: memory.category ?? "", tags: memory.tags.join(", ") });
    setNotice(""); setError("");
    document.getElementById("memory-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function removeMemory(memory: Memory) {
    if (!window.confirm(`Delete “${memory.title}”? This cannot be undone.`)) return;
    setBusy(true); setError("");
    try { await request<null>(`/memories/${memory.id}`, { method: "DELETE" }); setNotice("Memory deleted."); await loadMemories(query); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not delete this Memory."); }
    finally { setBusy(false); }
  }

  async function handleSignOut() {
    await signOut(); setSignedIn(false); setMemories([]); setDraft(blankDraft); setEditingId(null); setEditingMemory(null); setError("");
  }

  if (checkingSession) return <main className="center-shell"><div className="spinner" aria-label="Checking session" /></main>;
  if (!signedIn) return <main className="auth-shell">
    <section className="auth-card">
      <div className="brand-mark">M</div>
      <p className="eyebrow">YOUR PRIVATE LIBRARY</p>
      <h1>Keep important things close.</h1>
      <p className="muted">Sign in to access your saved documents and notes.</p>
      <form onSubmit={handleSignIn} className="form-stack">
        <label>Email or username<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? "Signing in…" : "Sign in securely"}</button>
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
      <div className="columns">
        <section className="library-panel">
          <form className="search" onSubmit={(e) => { e.preventDefault(); void loadMemories(query); }}><span aria-hidden="true">⌕</span><input aria-label="Search Memories" placeholder="Search your library" value={query} onChange={(e) => setQuery(e.target.value)} /><button type="submit" disabled={busy}>Search</button></form>
          {busy && memories.length === 0 ? <div className="empty">Loading your library…</div> : memories.length === 0 ? <div className="empty"><div className="empty-icon">✳</div><h2>Your library is ready</h2><p>Add a note or document detail using the form.</p></div> : <div className="memory-list">{memories.map((memory) => <article className="memory-card" key={memory.id}>
            <div className="memory-icon">{(memory.category || "M").slice(0, 1).toUpperCase()}</div><div className="memory-main"><div className="memory-title-row"><h2>{memory.title}</h2><span className="date">{dateLabel(memory.created_at)}</span></div>{memory.category && <p className="category">{memory.category}</p>}<p className="memory-copy">{memory.confirmed_content || memory.original_text}</p>{memory.tags.length > 0 && <div className="tags">{memory.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}<div className="card-actions"><button onClick={() => startEdit(memory)}>Edit</button><button className="delete-link" onClick={() => void removeMemory(memory)}>Delete</button></div></div>
          </article>)}</div>}
        </section>
        <aside className="editor-panel" id="memory-form"><p className="eyebrow">MANUAL ENTRY</p><h2>{editingId === null ? "Add a Memory" : "Edit Memory"}</h2><p className="muted small-copy">Manual saving works without AI.</p>
          <form className="form-stack" onSubmit={handleSave}>
            <label>Title<input maxLength={200} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="e.g. Power bill — November" required /></label>
            <label>Details<textarea rows={6} value={draft.original_text} onChange={(e) => setDraft({ ...draft, original_text: e.target.value })} placeholder="Write the details you want to remember" required /></label>
            <label>Category<input maxLength={100} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} placeholder="Bill, receipt, notice…" /></label>
            <label>Tags<input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="Separate tags with commas" /></label>
            <button className="primary-button" disabled={busy}>{busy ? "Saving…" : editingId === null ? "Save Memory" : "Save changes"}</button>
            {editingId !== null && <button type="button" className="quiet-button cancel-button" onClick={() => { setEditingId(null); setEditingMemory(null); setDraft(blankDraft); }}>Cancel edit</button>}
          </form>
        </aside>
      </div>
      <footer className="footer">Connected to your private account{API_URL ? <span> · AWS API</span> : null}</footer>
    </main>
  </div>;
}
