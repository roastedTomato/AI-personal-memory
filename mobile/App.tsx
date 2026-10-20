import React, { useEffect, useState } from "react";
import { Alert, Button, FlatList, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

type Memory = { id: number; title: string; original_text: string; confirmed_content: string; category?: string | null; tags: string[]; source_type: string; confirmation_status: string; created_at: string; updated_at: string };
type Draft = { title: string; original_text: string; category: string; tags: string };
const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://127.0.0.1:8000";
const emptyDraft: Draft = { title: "", original_text: "", category: "", tags: "" };

async function request(path: string, options?: RequestInit) {
  const response = await fetch(`${API_URL}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  if (!response.ok) throw new Error((await response.text()) || `Request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

export default function App() {
  const [screen, setScreen] = useState<"list" | "form" | "detail">("list");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [selected, setSelected] = useState<Memory | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loading, setLoading] = useState(false);

  const load = async () => { setLoading(true); try { setMemories(await request("/memories")); } catch (e) { Alert.alert("加载失败", String(e)); } finally { setLoading(false); } };
  useEffect(() => { load(); }, []);
  const openCreate = () => { setSelected(null); setDraft(emptyDraft); setScreen("form"); };
  const openEdit = () => { if (!selected) return; setDraft({ title: selected.title, original_text: selected.original_text, category: selected.category || "", tags: selected.tags.join(", ") }); setScreen("form"); };
  const save = async () => { if (!draft.title.trim() || !draft.original_text.trim()) return Alert.alert("请填写标题和内容"); const payload = { title: draft.title.trim(), original_text: draft.original_text.trim(), confirmed_content: draft.original_text.trim(), category: draft.category.trim() || null, tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean) }; try { const value = selected ? await request(`/memories/${selected.id}`, { method: "PATCH", body: JSON.stringify(payload) }) : await request("/memories", { method: "POST", body: JSON.stringify(payload) }); setSelected(value); await load(); setScreen("detail"); } catch (e) { Alert.alert("保存失败", String(e)); } };
  const remove = () => { if (!selected) return; Alert.alert("删除 Memory", "确定删除吗？", [{ text: "取消" }, { text: "删除", style: "destructive", onPress: async () => { try { await request(`/memories/${selected.id}`, { method: "DELETE" }); setSelected(null); await load(); setScreen("list"); } catch (e) { Alert.alert("删除失败", String(e)); } } }]); };
  if (screen === "form") return <Form draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setScreen(selected ? "detail" : "list")} editing={!!selected} />;
  if (screen === "detail" && selected) return <SafeAreaView style={styles.container}><ScrollView><Text style={styles.title}>{selected.title}</Text><Text style={styles.meta}>{selected.category || "未分类"} · {selected.tags.join(", ") || "无标签"}</Text><Text style={styles.content}>{selected.original_text}</Text><Button title="编辑" onPress={openEdit} /><Button title="删除" color="#b00020" onPress={remove} /><Button title="返回列表" onPress={() => setScreen("list")} /></ScrollView></SafeAreaView>;
  return <SafeAreaView style={styles.container}><Text style={styles.title}>我的 Memories</Text><Button title="新建 Memory" onPress={openCreate} /><Text style={styles.status}>{loading ? "加载中…" : memories.length ? `${memories.length} 条记录` : "还没有 Memory"}</Text><FlatList data={memories} keyExtractor={(item) => String(item.id)} renderItem={({ item }) => <TouchableOpacity style={styles.card} onPress={() => { setSelected(item); setScreen("detail"); }}><Text style={styles.cardTitle}>{item.title}</Text><Text numberOfLines={2}>{item.original_text}</Text></TouchableOpacity>} refreshing={loading} onRefresh={load} /></SafeAreaView>;
}

function Form({ draft, setDraft, onSave, onCancel, editing }: { draft: Draft; setDraft: (draft: Draft) => void; onSave: () => void; onCancel: () => void; editing: boolean }) { const field = (key: keyof Draft, placeholder: string, multiline = false) => <TextInput style={[styles.input, multiline && styles.multiline]} placeholder={placeholder} value={draft[key]} onChangeText={(value) => setDraft({ ...draft, [key]: value })} multiline={multiline} />; return <SafeAreaView style={styles.container}><ScrollView><Text style={styles.title}>{editing ? "编辑 Memory" : "新建 Memory"}</Text>{field("title", "标题")}{field("original_text", "内容", true)}{field("category", "分类")}{field("tags", "标签，用逗号分隔") }<Button title="保存" onPress={onSave} /><Button title="取消" onPress={onCancel} /></ScrollView></SafeAreaView>; }

const styles = StyleSheet.create({ container: { flex: 1, padding: 20, gap: 12 }, title: { fontSize: 28, fontWeight: "700", marginBottom: 12 }, status: { color: "#666", marginVertical: 8 }, card: { padding: 16, borderWidth: 1, borderColor: "#ddd", borderRadius: 8, marginBottom: 10 }, cardTitle: { fontSize: 18, fontWeight: "600", marginBottom: 6 }, meta: { color: "#666", marginBottom: 20 }, content: { fontSize: 17, lineHeight: 26, marginBottom: 24 }, input: { borderWidth: 1, borderColor: "#bbb", borderRadius: 6, padding: 12, fontSize: 16, marginBottom: 12 }, multiline: { minHeight: 140, textAlignVertical: "top" } });
