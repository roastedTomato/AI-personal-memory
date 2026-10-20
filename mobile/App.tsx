import React, { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Button, FlatList, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import DateTimePicker from "@react-native-community/datetimepicker";

type Memory = { id: number; title: string; original_text: string; confirmed_content: string; category?: string | null; tags: string[]; source_type: string; confirmation_status: string; reminder_at?: string | null; created_at: string; updated_at: string };
type AIDraftField = { value: string; confidence: number; uncertain: boolean };
type AIDraft = { summary: string; category: AIDraftField; tags: AIDraftField[] };
type AIAssistResponse = { memory_id: number; ai_status: string; draft?: AIDraft; warnings: string[]; error?: string | null };
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
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDraft, setAiDraft] = useState<AIAssistResponse | null>(null);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [searchResults, setSearchResults] = useState<Memory[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [reminderDate, setReminderDate] = useState<Date | null>(null);
  const [pickerMode, setPickerMode] = useState<"date" | "time" | null>(null);
  const [notificationMap, setNotificationMap] = useState<Record<string, { notification_id: string; reminder_at: string }>>({});
  const [reminderError, setReminderError] = useState<string | null>(null);

  const load = async () => { setLoading(true); try { setMemories(await request("/memories")); } catch (e) { Alert.alert("加载失败", String(e)); } finally { setLoading(false); } };
  const search = async () => { const keyword = searchKeyword.trim(); if (!keyword) return clearSearch(); setSearchLoading(true); setSearchError(null); try { setSearchResults(await request(`/memories?q=${encodeURIComponent(keyword)}`)); } catch (e) { setSearchError("搜索失败，请重试"); } finally { setSearchLoading(false); } };
  const clearSearch = async () => { setSearchKeyword(""); setSearchResults(null); setSearchError(null); await load(); };
  useEffect(() => { load(); AsyncStorage.getItem("memory-reminder-notifications").then((value) => { if (value) setNotificationMap(JSON.parse(value)); }); const subscription = Notifications.addNotificationResponseReceivedListener(async (response) => { const memoryId = response.notification.request.content.data?.memoryId; if (memoryId) { try { const value = await request(`/memories/${memoryId}`); setSelected(value); setReminderDate(value.reminder_at ? new Date(value.reminder_at) : null); setScreen("detail"); } catch { Alert.alert("提醒", "关联的 Memory 不再可用"); } } }); return () => subscription.remove(); }, []);
  const openCreate = () => { setSelected(null); setAiDraft(null); setDraft(emptyDraft); setScreen("form"); };
  const openDetail = (memory: Memory) => { setSelected(memory); setAiDraft(null); setReminderDate(memory.reminder_at ? new Date(memory.reminder_at) : null); setReminderError(null); setScreen("detail"); };
  const openEdit = () => { if (!selected) return; setDraft({ title: selected.title, original_text: selected.original_text, category: selected.category || "", tags: selected.tags.join(", ") }); setScreen("form"); };
  const save = async () => { if (!draft.title.trim() || !draft.original_text.trim()) return Alert.alert("请填写标题和内容"); const payload = { title: draft.title.trim(), original_text: draft.original_text.trim(), confirmed_content: draft.original_text.trim(), category: draft.category.trim() || null, tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean) }; try { const value = selected ? await request(`/memories/${selected.id}`, { method: "PATCH", body: JSON.stringify(payload) }) : await request("/memories", { method: "POST", body: JSON.stringify(payload) }); setSelected(value); await load(); setScreen("detail"); } catch (e) { Alert.alert("保存失败", String(e)); } };
  const remove = () => { if (!selected) return; Alert.alert("删除 Memory", "确定删除吗？", [{ text: "取消" }, { text: "删除", style: "destructive", onPress: async () => { try { await request(`/memories/${selected.id}`, { method: "DELETE" }); setSelected(null); await load(); setScreen("list"); } catch (e) { Alert.alert("删除失败", String(e)); } } }]); };
  const generateAI = async () => { if (!selected) return; setAiLoading(true); setAiDraft(null); try { setAiDraft(await request(`/memories/${selected.id}/assist`, { method: "POST", body: JSON.stringify({ operations: ["summary", "classification", "tags"] }) })); } catch (e) { Alert.alert("AI 草稿失败", "AI 不可用，仍可继续手动编辑和保存。\n" + String(e)); } finally { setAiLoading(false); } };
  const acceptAI = async () => { if (!selected || !aiDraft?.draft) return; try { const value = await request(`/memories/${selected.id}`, { method: "PATCH", body: JSON.stringify({ confirmed_content: aiDraft.draft.summary, category: aiDraft.draft.category.value, tags: aiDraft.draft.tags.map((tag) => tag.value), confirmation_status: "accepted" }) }); setSelected(value); setAiDraft(null); await load(); } catch (e) { Alert.alert("接受草稿失败", String(e)); } };
  const rejectAI = async () => { if (!selected) return; try { const value = await request(`/memories/${selected.id}`, { method: "PATCH", body: JSON.stringify({ confirmation_status: "rejected" }) }); setSelected(value); setAiDraft(null); } catch (e) { Alert.alert("拒绝草稿失败", String(e)); } };
  const persistNotificationMap = async (next: typeof notificationMap) => { setNotificationMap(next); await AsyncStorage.setItem("memory-reminder-notifications", JSON.stringify(next)); };
  const clearNotificationMetadata = async (memoryId: number) => { const next = { ...notificationMap }; delete next[String(memoryId)]; await persistNotificationMap(next); };
  const setReminder = async () => {
    if (!selected || !reminderDate || reminderDate <= new Date()) return setReminderError("请选择未来的日期和时间");
    setReminderError(null);
    const previous = notificationMap[String(selected.id)];
    let newNotificationId: string | null = null;
    try {
      const permission = await Notifications.getPermissionsAsync();
      const granted = permission.granted || (await Notifications.requestPermissionsAsync()).granted;
      if (!granted) { setReminderError("通知权限被拒绝，未创建本地通知。"); return; }
      if (previous) await Notifications.cancelScheduledNotificationAsync(previous.notification_id);
      newNotificationId = await Notifications.scheduleNotificationAsync({ content: { title: selected.title, body: "Memory 提醒", data: { memoryId: selected.id } }, trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: reminderDate } });
      await persistNotificationMap({ ...notificationMap, [selected.id]: { notification_id: newNotificationId, reminder_at: reminderDate.toISOString() } });
      try {
        const saved = await request(`/memories/${selected.id}/reminder`, { method: "PUT", body: JSON.stringify({ reminder_at: reminderDate.toISOString() }) });
        setSelected({ ...selected, reminder_at: saved.reminder_at });
      } catch (error) {
        console.error("backend reminder save failed", error);
        await Notifications.cancelScheduledNotificationAsync(newNotificationId);
        await clearNotificationMetadata(selected.id);
        setReminderError(`无法保存到后端，已撤销本地通知：${String(error)}`);
      }
    } catch (error) {
      console.error("notification scheduling or persistence failed", error);
      if (newNotificationId) { try { await Notifications.cancelScheduledNotificationAsync(newNotificationId); } catch (rollbackError) { console.error("notification rollback failed", rollbackError); } }
      try { await clearNotificationMetadata(selected.id); } catch (storageError) { console.error("notification metadata cleanup failed", storageError); }
      setReminderError(`无法安排本地通知：${String(error)}`);
    }
  };
  const cancelReminder = async () => { if (!selected) return; const previous = notificationMap[String(selected.id)]; try { if (previous) await Notifications.cancelScheduledNotificationAsync(previous.notification_id); await request(`/memories/${selected.id}/reminder`, { method: "DELETE" }); await clearNotificationMetadata(selected.id); setReminderDate(null); setSelected({ ...selected, reminder_at: null }); setReminderError(null); } catch (error) { console.error("reminder cancellation failed", error); setReminderError("取消提醒失败，请重试。"); } };
  if (screen === "form") return <Form draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setScreen(selected ? "detail" : "list")} editing={!!selected} />;
  if (screen === "detail" && selected) return <SafeAreaView style={styles.container}><ScrollView><Text style={styles.title}>{selected.title}</Text><Text style={styles.meta}>{selected.category || "未分类"} · {selected.tags.join(", ") || "无标签"}</Text><Text style={styles.content}>{selected.original_text}</Text><View style={styles.reminderCard}><Text style={styles.aiTitle}>一次性提醒</Text><Button title={reminderDate ? reminderDate.toLocaleString() : "选择日期和时间"} onPress={() => setPickerMode("date")} />{pickerMode && <DateTimePicker key={pickerMode} value={reminderDate || new Date(Date.now() + 3600000)} mode={pickerMode} display="spinner" onValueChange={(_event, value) => { setReminderDate(value); }} onDismiss={() => setPickerMode(null)} />}{pickerMode && <Button title={pickerMode === "date" ? "下一步：选择时间" : "完成选择"} onPress={() => setPickerMode(pickerMode === "date" ? "time" : null)} />}<Button title={selected.reminder_at ? "更新提醒" : "设置提醒"} onPress={setReminder} />{selected.reminder_at && <><Text style={styles.meta}>已设置：{new Date(selected.reminder_at).toLocaleString()}</Text><Button title="取消提醒" color="#b00020" onPress={cancelReminder} /></>}{reminderError && <Text style={styles.error}>{reminderError}</Text>}</View><Button title={aiLoading ? "生成中…" : "生成 AI 草稿"} onPress={generateAI} disabled={aiLoading} />{aiDraft?.draft && <View style={styles.aiCard}><Text style={styles.aiTitle}>AI 草稿（需要你确认）</Text><Text style={styles.aiLabel}>摘要</Text><Text style={styles.content}>{aiDraft.draft.summary}</Text><Text style={styles.aiLabel}>分类：{aiDraft.draft.category.value}（置信度 {Math.round(aiDraft.draft.category.confidence * 100)}%，{aiDraft.draft.category.uncertain ? "不确定" : "较确定"}）</Text><Text style={styles.aiLabel}>标签：{aiDraft.draft.tags.map((tag) => tag.value).join(", ")}</Text>{aiDraft.warnings.map((warning) => <Text key={warning} style={styles.warning}>提示：{warning}</Text>)}<Button title="接受 AI 草稿" onPress={acceptAI} /><Button title="编辑后再保存" onPress={openEdit} /><Button title="拒绝 AI 草稿" color="#b00020" onPress={rejectAI} /></View>}<Button title="编辑" onPress={openEdit} /><Button title="删除" color="#b00020" onPress={remove} /><Button title="返回列表" onPress={() => setScreen("list")} /></ScrollView></SafeAreaView>;
  const displayedMemories = searchResults ?? memories;
  return <SafeAreaView style={styles.container}><Text style={styles.title}>我的 Memories</Text><View style={styles.searchRow}><TextInput style={styles.searchInput} placeholder="搜索标题、内容或标签" value={searchKeyword} onChangeText={(value) => { setSearchKeyword(value); if (!value.trim()) setSearchResults(null); setSearchError(null); }} onSubmitEditing={search} returnKeyType="search" /><Button title="搜索" onPress={search} /></View>{searchResults !== null && <Button title="清除搜索" onPress={clearSearch} />}{searchLoading && <ActivityIndicator />}{searchError && <View><Text style={styles.error}>{searchError}</Text><Button title="重试" onPress={search} /></View>}<Button title="新建 Memory" onPress={openCreate} /><Text style={styles.status}>{loading ? "加载中…" : searchResults !== null ? (displayedMemories.length ? `找到 ${displayedMemories.length} 条记录` : "没有找到匹配的 Memory") : (memories.length ? `${memories.length} 条记录` : "还没有 Memory")}</Text>{searchResults !== null && !displayedMemories.length ? <Button title="返回全部 Memory" onPress={clearSearch} /> : <FlatList data={displayedMemories} keyExtractor={(item) => String(item.id)} renderItem={({ item }) => <TouchableOpacity style={styles.card} onPress={() => openDetail(item)}><Text style={styles.cardTitle}>{item.title}</Text><Text numberOfLines={2}>{item.original_text}</Text></TouchableOpacity>} refreshing={loading} onRefresh={load} />}</SafeAreaView>;
}

function Form({ draft, setDraft, onSave, onCancel, editing }: { draft: Draft; setDraft: (draft: Draft) => void; onSave: () => void; onCancel: () => void; editing: boolean }) { const field = (key: keyof Draft, placeholder: string, multiline = false) => <TextInput style={[styles.input, multiline && styles.multiline]} placeholder={placeholder} value={draft[key]} onChangeText={(value) => setDraft({ ...draft, [key]: value })} multiline={multiline} />; return <SafeAreaView style={styles.container}><ScrollView><Text style={styles.title}>{editing ? "编辑 Memory" : "新建 Memory"}</Text>{field("title", "标题")}{field("original_text", "内容", true)}{field("category", "分类")}{field("tags", "标签，用逗号分隔") }<Button title="保存" onPress={onSave} /><Button title="取消" onPress={onCancel} /></ScrollView></SafeAreaView>; }

const styles = StyleSheet.create({ container: { flex: 1, padding: 20, gap: 12 }, title: { fontSize: 28, fontWeight: "700", marginBottom: 12 }, searchRow: { flexDirection: "row", alignItems: "center", gap: 8 }, searchInput: { flex: 1, borderWidth: 1, borderColor: "#bbb", borderRadius: 6, padding: 10, fontSize: 16 }, status: { color: "#666", marginVertical: 8 }, error: { color: "#b00020" }, card: { padding: 16, borderWidth: 1, borderColor: "#ddd", borderRadius: 8, marginBottom: 10 }, cardTitle: { fontSize: 18, fontWeight: "600", marginBottom: 6 }, meta: { color: "#666", marginBottom: 20 }, content: { fontSize: 17, lineHeight: 26, marginBottom: 24 }, reminderCard: { borderWidth: 1, borderColor: "#8ab4d6", borderRadius: 8, padding: 14, marginVertical: 12, gap: 8 }, aiCard: { borderWidth: 1, borderColor: "#e0b04b", borderRadius: 8, padding: 14, marginVertical: 12, gap: 8 }, aiTitle: { fontSize: 19, fontWeight: "700" }, aiLabel: { fontSize: 15, marginBottom: 6 }, warning: { color: "#8a5a00", marginBottom: 8 }, input: { borderWidth: 1, borderColor: "#bbb", borderRadius: 6, padding: 12, fontSize: 16, marginBottom: 12 }, multiline: { minHeight: 140, textAlignVertical: "top" } });
