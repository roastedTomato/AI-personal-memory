import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Button, FlatList, Image, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { APIError, visionRequestError } from "./apiErrors";
import { availableTags, displayTags, filterByTags } from "./tagFilter";
import { mapVisionEnvelope, visibleVisionFields, visionKeys, reminderSuggestion, suggestReminderIfUntouched, emptyVisionDraft, categoryFields, type VisionDraft, type VisionEnvelope, type VisionFieldKey } from "./visionDraft";

const restoreVisionDraft = (raw: string): VisionEnvelope | null => mapVisionEnvelope(JSON.parse(raw));
type Memory = { image_text_draft?: string | null; confirmed_image_text?: string | null; vision_draft?: string | null; vision_metadata?: string | null; confirmed_vision?: string | null; id: number; title: string; original_text: string; confirmed_content: string; category?: string | null; tags: string[]; source_type: string; confirmation_status: string; reminder_at?: string | null; ocr_text?: string | null; ocr_status?: string | null; ocr_error?: string | null; ocr_duration_ms?: number | null; source_image_path?: string | null; source_image_filename?: string | null; source_image_mime_type?: string | null; source_image_size?: number | null; created_at: string; updated_at: string };
type AIDraftField = { value: string; confidence: number; uncertain: boolean };
type AIDraft = { summary: string; category: AIDraftField; tags: AIDraftField[] };
type AIAssistResponse = { memory_id: number; ai_status: string; draft?: AIDraft; warnings: string[]; error?: string | null };
type Draft = { title: string; original_text: string; category: string; tags: string };
const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://127.0.0.1:8000";
const emptyDraft: Draft = { title: "", original_text: "", category: "", tags: "" };
const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const localTime = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const reminderDateTime = (day: string | null, time: string | null): Date | null => {
  if (!day || !time) return null;
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const value = new Date(year, month - 1, date, hour, minute);
  return localDay(value) === day && localTime(value) === time ? value : null;
};

async function request(path: string, options?: RequestInit) {
  const response = await fetch(`${API_URL}${path}`, { headers: { "Content-Type": "application/json" }, ...options });
  if (!response.ok) {
    let detail: unknown;
    try { detail = (await response.json()).detail; } catch { detail = undefined; }
    throw new APIError(response.status, detail);
  }
  return response.status === 204 ? null : response.json();
}

function uploadImage(memoryId: number, uri: string, name: string, type: string): Promise<Memory> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("image", { uri, name, type } as any);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/memories/${memoryId}/image`);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("Invalid upload response")); }
      } else reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error while uploading image"));
    xhr.send(form);
  });
}

async function uploadableImage(asset: ImagePicker.ImagePickerAsset): Promise<{ uri: string; name: string; type: string }> {
  const name = asset.fileName || "图片记忆.jpg";
  const type = asset.mimeType || "";
  if (["image/jpeg", "image/png", "image/webp"].includes(type) && !/\.(heic|heif|avif)$/i.test(name)) {
    return { uri: asset.uri, name, type };
  }
  // iOS can return original HEIC images; convert only unsupported formats locally.
  const rendered = await ImageManipulator.manipulate(asset.uri).renderAsync();
  const converted = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  return { uri: converted.uri, name: name.replace(/\.[^.]+$/, "") + ".jpg", type: "image/jpeg" };
}

function createMemoryFromImage(uri: string, name: string, type: string): Promise<Memory> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("image", { uri, name, type } as any);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_URL}/memories/from-image`);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error("Invalid image response")); }
      } else reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error while uploading image"));
    xhr.send(form);
  });
}

export default function App() {
  const [screen, setScreen] = useState<"list" | "form" | "detail" | "capture">("list");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [selected, setSelected] = useState<Memory | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editContent, setEditContent] = useState("");
  const [editVision, setEditVision] = useState<VisionDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDraft, setAiDraft] = useState<AIAssistResponse | null>(null);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [searchResults, setSearchResults] = useState<Memory[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showTagChoices, setShowTagChoices] = useState(false);
  const [reminderDay, setReminderDay] = useState<string | null>(null);
  const [reminderTime, setReminderTime] = useState<string | null>(null);
  const [reminderTouched, setReminderTouched] = useState(false);
  const reminderDrafts = useRef<Record<number, { day: string | null; time: string | null }>>({});
  const [pickerValue, setPickerValue] = useState(new Date());
  const [pickerMode, setPickerMode] = useState<"date" | "time" | null>(null);
  const [notificationMap, setNotificationMap] = useState<Record<string, { notification_id: string; reminder_at: string }>>({});
  const [reminderError, setReminderError] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageDraft, setImageDraft] = useState<any>(null);
  const [ocrText, setOcrText] = useState("");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrMessage, setOcrMessage] = useState<string | null>(null);
  const [reviewEditing, setReviewEditing] = useState(false);
  const [visionBusy, setVisionBusy] = useState(false);
  const visionLock = useRef(false);
  const [visionReview, setVisionReview] = useState<VisionEnvelope | null>(null);
  const [visionMessage, setVisionMessage] = useState<string | null>(null);
  const [imageText, setImageText] = useState("");
  const [confirmedText, setConfirmedText] = useState<string | null>(null);
  const [textWarnings, setTextWarnings] = useState<string[]>([]);
  const [showImageDraft, setShowImageDraft] = useState(true);
  const [showSavedImageText, setShowSavedImageText] = useState(false);
  const [showSavedOcrText, setShowSavedOcrText] = useState(false);
  const [showSavedImage, setShowSavedImage] = useState(false);
  const [captureTitle, setCaptureTitle] = useState("");
  const titleTouched = useRef(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const captureLock = useRef(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [manualContent, setManualContent] = useState("");
  useEffect(() => {
    setVisionReview(selected?.vision_draft ? restoreVisionDraft(selected.vision_draft) : null);
    setShowImageDraft(!selected?.confirmed_vision || !!selected?.vision_draft);
    const recognized = selected?.image_text_draft ? JSON.parse(selected.image_text_draft) : null;
    const pending = selected?.vision_draft ? JSON.parse(selected.vision_draft) : null;
    setImageText(pending?.reviewed_text ?? selected?.confirmed_image_text ?? recognized?.text ?? "");
    setTextWarnings(recognized?.warnings || []);
    setConfirmedText(null);
    setVisionMessage(null);
  }, [selected?.id]);

  const load = async () => { setLoading(true); setLoadError(null); try { setMemories(await request("/memories")); } catch { setLoadError("无法加载 Memories，请检查连接后重试。"); } finally { setLoading(false); } };
  const search = async () => { const keyword = searchKeyword.trim(); if (!keyword) return clearSearch(); setSearchLoading(true); setSearchError(null); try { setSearchResults(await request(`/memories?q=${encodeURIComponent(keyword)}`)); } catch (e) { setSearchError("搜索失败，请重试"); } finally { setSearchLoading(false); } };
  const clearSearch = async () => { setSearchKeyword(""); setSearchResults(null); setSearchError(null); await load(); };
  useEffect(() => { load(); AsyncStorage.getItem("memory-reminder-notifications").then((value) => { if (value) setNotificationMap(JSON.parse(value)); }); const subscription = Notifications.addNotificationResponseReceivedListener(async (response) => { const memoryId = response.notification.request.content.data?.memoryId; if (memoryId) { try { const value = await request(`/memories/${memoryId}`); setSelected(value); const current = value.reminder_at ? new Date(value.reminder_at) : null; setReminderDay(current ? localDay(current) : null); setReminderTime(current ? localTime(current) : null); setReminderTouched(false); setScreen("detail"); } catch { Alert.alert("提醒", "关联的 Memory 不再可用"); } } }); return () => subscription.remove(); }, []);
  const openCreate = () => { setSelected(null); setAiDraft(null); setDraft(emptyDraft); setScreen("form"); };
  const openDetail = (memory: Memory) => { setSelected(memory); setAiDraft(null);
    const recognized = memory.image_text_draft ? JSON.parse(memory.image_text_draft) : null;
    const pending = memory.vision_draft ? restoreVisionDraft(memory.vision_draft) : null;
    setVisionReview(pending); setImageText(pending?.reviewed_text ?? memory.confirmed_image_text ?? recognized?.text ?? "");
    setConfirmedText(null); setTextWarnings(recognized?.warnings || []);
    setShowImageDraft(!memory.confirmed_vision || !!pending); setImageDraft(null); setImageError(null); setOcrText(memory.ocr_text || ""); setOcrMessage(memory.ocr_status ? `OCR: ${memory.ocr_status} · ${memory.ocr_duration_ms ?? 0} ms` : null); const current = memory.reminder_at ? new Date(memory.reminder_at) : null;
    const storedDraft = memory.vision_draft ? restoreVisionDraft(memory.vision_draft)?.draft : memory.confirmed_vision ? JSON.parse(memory.confirmed_vision) as VisionDraft : null;
    const manual = memory.reminder_at ? null : reminderDrafts.current[memory.id];
    const suggestion = storedDraft ? suggestReminderIfUntouched(storedDraft, memory.reminder_at, !!manual) : null;
    setReminderDay(current ? localDay(current) : manual ? manual.day : suggestion?.day ?? null);
    setReminderTime(current ? localTime(current) : manual ? manual.time : suggestion?.time ?? null);
    setReminderTouched(!!manual); setShowSavedImageText(false); setShowSavedOcrText(false); setShowSavedImage(false); setReminderError(null); setCaptureTitle(memory.title); titleTouched.current = memory.confirmation_status !== "draft"; setManualContent(""); setCaptureError(null); setScreen(memory.confirmation_status === "draft" ? "capture" : "detail"); };
  const updateReminderFromDraft = (fields: VisionDraft) => {
    if (!selected || selected.reminder_at || reminderTouched || reminderDrafts.current[selected.id]) return;
    const suggestion = reminderSuggestion(fields);
    setReminderDay(suggestion?.day ?? null);
    setReminderTime(suggestion?.time ?? null);
  };
  const editVisionFields = (fields: VisionDraft) => { setEditVision(fields); updateReminderFromDraft(fields); };
  const reviewVisionFields = (fields: VisionDraft) => { setVisionReview((current) => current ? { ...current, draft: fields } : null); updateReminderFromDraft(fields); };
  const openEdit = () => { if (!selected) return; setDraft({ title: selected.title, original_text: selected.original_text, category: selected.category || "", tags: selected.tags.join(", ") }); setEditContent(selected.confirmed_content); const fields = selected.confirmed_vision ? mapVisionEnvelope({ draft_id: "confirmed", draft: JSON.parse(selected.confirmed_vision) })?.draft ?? emptyVisionDraft() : { ...emptyVisionDraft(), summary: selected.confirmed_content || null, category: selected.category || null, tags: selected.tags }; setEditVision(fields); if (!selected.reminder_at && !reminderTouched && !reminderDrafts.current[selected.id]) { const suggestion = reminderSuggestion(fields); if (suggestion) { setReminderDay(suggestion.day); setReminderTime(suggestion.time); } } setScreen("form"); };
  const save = async () => { if (selected?.source_image_path) { if (!draft.title.trim()) return Alert.alert("请填写标题"); try { const value = await request(`/memories/${selected.id}/image/confirmed`, { method: "PATCH", body: JSON.stringify({ title: draft.title.trim(), confirmed_content: editVision?.summary ?? editContent, draft: editVision }) }); setSelected(value); await load(); setScreen("detail"); } catch (e) { Alert.alert("保存失败", visionRequestError(e)); } return; } if (!draft.title.trim() || !draft.original_text.trim()) return Alert.alert("请填写标题和内容"); const payload = { title: draft.title.trim(), original_text: draft.original_text.trim(), confirmed_content: selected && draft.original_text.trim() === selected.original_text ? selected.confirmed_content : draft.original_text.trim(), category: draft.category.trim() || null, tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean) }; try { const value = selected ? await request(`/memories/${selected.id}`, { method: "PATCH", body: JSON.stringify(payload) }) : await request("/memories", { method: "POST", body: JSON.stringify(payload) }); setSelected(value); await load(); setScreen("detail"); } catch (e) { Alert.alert("保存失败", String(e)); } };
  const remove = () => { if (!selected) return; Alert.alert("删除 Memory", "确定删除吗？", [{ text: "取消" }, { text: "删除", style: "destructive", onPress: async () => { try { await request(`/memories/${selected.id}`, { method: "DELETE" }); setSelected(null); await load(); setScreen("list"); } catch (e) { Alert.alert("删除失败", String(e)); } } }]); };
  const chooseImage = async () => {
    if (!selected) return;
    setImageError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) { setImageError("图片库权限被拒绝，仍可手动编辑 Memory。"); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    Alert.alert("处理这张图片？", "先在本机识别文字，再将文字发送到 OpenAI 分析。图片本身不会在首次处理时发送。", [
      { text: "取消", style: "cancel" },
      { text: "同意并处理", onPress: async () => {
    setImageLoading(true);
    try {
      const prepared = await uploadableImage(asset);
      const value = await uploadImage(selected.id, prepared.uri, prepared.name, prepared.type);
      setSelected(value); setVisionReview(null); setVisionMessage(null); setShowImageDraft(true); setShowSavedImageText(false); setShowSavedOcrText(false); setShowSavedImage(false); setImageText(""); setConfirmedText(null); setTextWarnings([]); setOcrText(""); setOcrMessage(null);
      const ocr = await request(`/memories/${value.id}/image/ocr`, { method: "POST" });
      setOcrText(ocr.text || ""); setImageText(ocr.text || "");
      setSelected((current) => current?.id === value.id ? { ...current, ocr_text: ocr.text, ocr_status: ocr.status, ocr_duration_ms: ocr.duration_ms } : current);
      if (ocr.status === "completed" && ocr.text?.trim()) await analyzeCaptureText(value, ocr.text);
      else setCaptureError("本地 OCR 未识别到文字。图片和原有内容保留，可手动编辑 Memory。");
    } catch (e) { console.error("image upload or parse failed", e); setImageError("图片上传或解析失败，仍可手动保存 Memory。"); } finally { setImageLoading(false); }
      } },
    ]);
  };

  const analyzeCaptureText = async (memory: Memory, text: string) => {
    if (!text.trim()) return;
    try {
      const result = await request(`/memories/${memory.id}/image/analyze-draft`, { method: "POST", body: JSON.stringify({ consent: true, request_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, text }) });
      if (result.metadata?.status === "failed") {
        setCaptureError(`AI 分析失败：${visionErrors[result.metadata.error] || result.metadata.error}。图片和 OCR 结果已保留，可编辑后确认保存。`);
      } else {
        const mapped = mapVisionEnvelope(result.vision);
        setVisionReview(mapped);
        if (memory.confirmation_status === "draft" && !titleTouched.current && mapped?.draft.suggested_title?.trim()) setCaptureTitle(mapped.draft.suggested_title.trim());
        const suggestion = mapped?.draft ? suggestReminderIfUntouched(mapped.draft, memory.reminder_at, reminderTouched) : null;
        if (suggestion) { setReminderDay(suggestion.day); setReminderTime(suggestion.time); }
        setCaptureError(null);
      }
      const refreshed = await request(`/memories/${memory.id}`);
      setSelected(refreshed);
      await load();
    } catch (error) { setCaptureError(`AI 分析失败：${visionRequestError(error)}。可继续编辑并保存。`); }
  };

  const startImageMemory = async (asset: ImagePicker.ImagePickerAsset) => {
    if (captureLock.current) return;
    captureLock.current = true; setCaptureBusy(true); setCaptureError(null);
    try {
      const prepared = await uploadableImage(asset);
      const memory = await createMemoryFromImage(prepared.uri, prepared.name, prepared.type);
      setSelected(memory); setCaptureTitle(memory.title); titleTouched.current = false; setManualContent(""); setImageText(""); setOcrText(""); setVisionReview(null);
      setReminderDay(null); setReminderTime(null); setReminderTouched(false); setShowSavedImage(false);
      setScreen("capture"); await load();
      try {
        const result = await request(`/memories/${memory.id}/image/ocr`, { method: "POST" });
        setOcrText(result.text || ""); setImageText(result.text || "");
        setSelected((current) => current?.id === memory.id ? { ...current, ocr_text: result.text, ocr_status: result.status, ocr_duration_ms: result.duration_ms } : current);
        if (result.status !== "completed" || !result.text?.trim()) {
          setCaptureError("本地 OCR 未识别到文字。图片已保留，可输入文字后保存或重新分析。");
        } else await analyzeCaptureText(memory, result.text);
      } catch (error) { setCaptureError("本地 OCR 失败。图片已保留，可手动输入并保存。"); }
    } catch (error) { Alert.alert("无法创建图片 Memory", String(error)); }
    finally { captureLock.current = false; setCaptureBusy(false); }
  };

  const chooseNewImage = async (source: "camera" | "library") => {
    if (captureLock.current) return;
    try {
    const permission = source === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert("需要图片权限", source === "camera" ? "请允许使用相机。" : "请允许访问相册。");
    const result = source === "camera"
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    Alert.alert("处理这张图片？", "先在本机识别文字，再将文字发送给 OpenAI 分析。图片本身不会发送；分析失败仍可手动保存。", [
      { text: "取消", style: "cancel" },
      { text: "同意并处理", onPress: () => startImageMemory(asset) },
    ]);
    } catch (error) { Alert.alert("无法打开图片", String(error)); }
  };

  const reanalyzeImage = async () => {
    if (!selected || captureLock.current) return;
    const memory = selected;
    captureLock.current = true; setCaptureBusy(true); setCaptureError(null); setVisionMessage(null);
    try {
      const result = await request(`/memories/${memory.id}/image/reanalyze`, { method: "POST", body: JSON.stringify({ consent: true, request_id: `${Date.now()}-${Math.random().toString(36).slice(2)}` }) });
      if (result.metadata?.status === "failed") {
        setCaptureError(`OpenAI 图片识别失败：${visionErrors[result.metadata.error] || result.metadata.error}。原图和已保存内容保留。`);
      } else {
        const mapped = mapVisionEnvelope(result.vision);
        setVisionReview(mapped);
        if (memory.confirmation_status === "draft" && !titleTouched.current && mapped?.draft.suggested_title?.trim()) setCaptureTitle(mapped.draft.suggested_title.trim());
        setImageText(result.recognition?.text || "");
        setShowImageDraft(true);
        const suggestion = mapVisionEnvelope(result.vision)?.draft && suggestReminderIfUntouched(mapVisionEnvelope(result.vision)!.draft, memory.reminder_at, reminderTouched);
        if (suggestion) { setReminderDay(suggestion.day); setReminderTime(suggestion.time); }
      }
      const refreshed = await request(`/memories/${memory.id}`);
      setSelected(refreshed); await load();
    } catch (error) { setCaptureError(`OpenAI 图片识别失败：${visionRequestError(error)}。原图和已保存内容保留。`); }
    finally { captureLock.current = false; setCaptureBusy(false); }
  };
  const confirmReanalyzeImage = () => Alert.alert("将原图发送到 OpenAI？", "仅这次主动重新识别会发送原图，并产生一次模型请求。结果仍需审核。", [
    { text: "取消", style: "cancel" }, { text: "同意并重新识别", onPress: reanalyzeImage },
  ]);

  const finalizeCapture = async () => {
    if (!selected || captureLock.current || !captureTitle.trim()) return Alert.alert("请填写标题");
    captureLock.current = true; setCaptureBusy(true);
    try {
      const value = await request(`/memories/${selected.id}/image/finalize`, { method: "POST", body: JSON.stringify({
        title: captureTitle.trim(), text: visionReview ? "" : manualContent, source_image_path: selected.source_image_path,
        draft_id: visionReview?.draft_id ?? null, draft: visionReview?.draft ?? null,
      }) });
      setSelected(value); setVisionReview(null); setShowImageDraft(false); setScreen("detail");
      await load();
    } catch (error) { setCaptureError(`保存失败：${visionRequestError(error)}。草稿和图片仍可编辑。`); }
    finally { captureLock.current = false; setCaptureBusy(false); }
  };

  const recognizeText = async () => {
    if (!selected || ocrBusy) return;
    const id = selected.id;
    setOcrBusy(true); setImageError(null);
    try {
      const result = await request(`/memories/${id}/image/ocr`, { method: "POST" });
      setOcrMessage(`OCR: ${result.status} · ${result.duration_ms} ms`);
      setSelected((current) => current?.id === id ? { ...current, ocr_text: result.text, ocr_status: result.status, ocr_duration_ms: result.duration_ms } : current);
      if (result.text) { setOcrText(result.text); setImageText(result.text); setConfirmedText(null); setVisionReview(null); setShowImageDraft(true); }
      if (result.status !== "completed") setImageError(`未识别到文字或识别失败（${result.error || result.status}），原图已保留，可手动输入。`);
    } catch { setImageError("OCR 请求失败，原图已保留，可手动输入或继续编辑 Memory。"); }
    finally { setOcrBusy(false); }
  };
  const parseOCR = async () => {
    if (!selected || !ocrText.trim() || ocrBusy) return;
    setOcrBusy(true); setImageError(null);
    try { setAiDraft(await request(`/memories/${selected.id}/image/parse`, { method: "POST", body: JSON.stringify({ text: ocrText }) })); setReviewEditing(false); }
    catch { setImageError("Mock 草稿生成失败，识别文字保留，可继续手动编辑。"); }
    finally { setOcrBusy(false); }
  };

  const visionErrors: Record<string, string> = { key_not_configured: "后端尚未配置 API Key", authentication_failed: "OpenAI 密钥或权限无效", insufficient_quota: "OpenAI 余额或配额不足", rate_limited: "OpenAI 限流，请稍后手动重试", timeout: "解析超时，未自动重试", network_error: "无法连接 OpenAI", refused: "模型拒绝解析这张图片", invalid_output: "模型返回格式无效", incomplete_output: "输出不完整", provider_error: "OpenAI 服务请求失败", image_size_limit: "视觉解析仅支持最大 5 MB 图片", unsupported_image: "图片格式无效" };
  const runVision = async (stage: "recognition" | "analysis") => {
    if (!selected || visionLock.current) return;
    if (stage === "analysis" && (!imageText.trim() || confirmedText !== imageText)) return;
    const memory = selected;
    const reviewedText = imageText;
    visionLock.current = true; setVisionBusy(true); setVisionMessage(null);
    try {
      const result = await request(`/memories/${memory.id}/image/${stage === "recognition" ? "recognize" : "analyze"}`, { method: "POST", body: JSON.stringify({ consent: true, request_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ...(stage === "analysis" ? { text_confirmed: true, text: reviewedText } : {}) }) });
      const meta = result.metadata;
      setShowImageDraft(true);
      if (stage === "analysis" && meta?.status === "generated" && !memory.reminder_at && !reminderTouched && result.vision?.draft) {
        const suggestion = reminderSuggestion(result.vision.draft);
        if (suggestion) { setReminderDay(suggestion.day); setReminderTime(suggestion.time); }
      }
      if (meta?.status === "failed") {
        setVisionMessage(`${visionErrors[meta.error] || "请求失败"}。原图和已确认内容保留，可修改文字后手动保存。`);
      } else {
        setVisionReview(mapVisionEnvelope(result.vision));
        if (stage === "recognition") {
          setImageText(result.recognition?.text || ""); setConfirmedText(null);
          setTextWarnings(result.recognition?.warnings || []);
        }
        setVisionMessage(`${meta?.status === "no_text" ? "未识别到文字，可手动输入。 " : ""}模型 ${meta?.model} · ${meta?.duration_ms} ms · ${meta?.usage?.total_tokens ?? "未知"} tokens`);
      }
      const refreshed = await request(`/memories/${memory.id}`);
      setSelected((current) => current?.id === memory.id ? refreshed : current);
      await load();
    } catch (error) { setVisionMessage(`${visionRequestError(error)} 未自动重试，原图和原有内容保留。`); }
    finally { visionLock.current = false; setVisionBusy(false); }
  };
  const confirmVision = (stage: "recognition" | "analysis") => {
    if (visionLock.current) return;
    Alert.alert(stage === "recognition" ? "发送图片到 OpenAI 识别文字？" : "发送确认后的文字到 OpenAI 分析？", stage === "recognition" ? "仅发送本次图片进行文字识别，可能包含个人信息并产生费用。返回内容仍需你核对。" : "只发送你已确认的文字，不发送图片或手机位置。分析结果需要再次审核后保存。", [{ text: "取消", style: "cancel" }, { text: "同意并继续", onPress: () => runVision(stage) }]);
  };

  const acceptVision = async () => {
    if (!selected || !visionReview || visionLock.current) return;
    visionLock.current = true; setVisionBusy(true);
    try {
      const value = await request(`/memories/${selected.id}/image/vision/accept`, { method: "POST", body: JSON.stringify({ ...visionReview, title: captureTitle.trim() }) });
      setSelected(value); setVisionReview(null); setAiDraft(null); setShowImageDraft(false); setVisionMessage("已确认并保存；原文和原图保留。"); await load();
    } catch (error) { setVisionMessage(`保存失败：${visionRequestError(error)}`); }
    finally { visionLock.current = false; setVisionBusy(false); }
  };
  const rejectVision = async () => {
    if (!selected || visionLock.current) return;
    visionLock.current = true; setVisionBusy(true);
    try { await request(`/memories/${selected.id}/image/vision`, { method: "DELETE" }); const refreshed = await request(`/memories/${selected.id}`); setSelected(refreshed); setVisionReview(null); setVisionMessage("已拒绝草稿，原有内容保留。"); await load(); }
    catch (error) { setVisionMessage(`拒绝草稿失败：${visionRequestError(error)}`); }
    finally { visionLock.current = false; setVisionBusy(false); }
  };

  const generateAI = async () => { if (!selected) return; setAiLoading(true); setAiDraft(null); try { setAiDraft(await request(`/memories/${selected.id}/assist`, { method: "POST", body: JSON.stringify({ operations: ["summary", "classification", "tags"] }) })); } catch (e) { Alert.alert("AI 草稿失败", "AI 不可用，仍可继续手动编辑和保存。\n" + String(e)); } finally { setAiLoading(false); } };
  const acceptAI = async () => { if (!selected || !aiDraft?.draft) return; try { const value = await request(`/memories/${selected.id}`, { method: "PATCH", body: JSON.stringify({ confirmed_content: aiDraft.draft.summary, category: aiDraft.draft.category.value, tags: aiDraft.draft.tags.map((tag) => tag.value), confirmation_status: "accepted" }) }); setSelected(value); setAiDraft(null); await load(); } catch (e) { Alert.alert("接受草稿失败", String(e)); } };
  const rejectAI = async () => { if (!selected) return; try { const value = await request(`/memories/${selected.id}`, { method: "PATCH", body: JSON.stringify({ confirmation_status: "rejected" }) }); setSelected(value); setAiDraft(null); } catch (e) { Alert.alert("拒绝草稿失败", String(e)); } };
  const persistNotificationMap = async (next: typeof notificationMap) => { setNotificationMap(next); await AsyncStorage.setItem("memory-reminder-notifications", JSON.stringify(next)); };
  const clearNotificationMetadata = async (memoryId: number) => { const next = { ...notificationMap }; delete next[String(memoryId)]; await persistNotificationMap(next); };
  const setReminder = async () => {
    const reminderDate = reminderDateTime(reminderDay, reminderTime);
    if (!selected || !reminderDay || !reminderTime || !reminderDate) return setReminderError("请选择提醒日期和具体时间；仅识别到日期时不会自动补时间。");
    if (reminderDate <= new Date()) return setReminderError("请选择未来的日期和时间");
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
        delete reminderDrafts.current[selected.id];
        setReminderTouched(false);
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
  const cancelReminder = async () => { if (!selected) return; const previous = notificationMap[String(selected.id)]; try { if (previous) await Notifications.cancelScheduledNotificationAsync(previous.notification_id); await request(`/memories/${selected.id}/reminder`, { method: "DELETE" }); await clearNotificationMetadata(selected.id); delete reminderDrafts.current[selected.id]; setReminderDay(null); setReminderTime(null); setReminderTouched(false); setSelected({ ...selected, reminder_at: null }); setReminderError(null); } catch (error) { console.error("reminder cancellation failed", error); setReminderError("取消提醒失败，请重试。"); } };
  if (screen === "capture" && selected) return <SafeAreaView style={styles.container}><ScrollView>
    <Text style={styles.title}>审核图片 Memory</Text>
    <Text style={styles.status}>图片和识别结果已保留。确认前，最终内容不会更新。</Text>
    <Text style={styles.aiLabel}>标题</Text><TextInput style={styles.input} value={captureTitle} onChangeText={(title) => { setCaptureTitle(title); titleTouched.current = true; }} editable={!captureBusy} maxLength={200} />
    {selected.source_image_path && <><Button title={showSavedImage ? "收起图片" : "展开图片"} onPress={() => setShowSavedImage(!showSavedImage)} />
      {showSavedImage && <Image style={styles.sourceImage} source={{ uri: `${API_URL}/memories/${selected.id}/image/file` }} resizeMode="contain" />}</>}
    <Button title="使用 OpenAI 重新识别并分析" onPress={confirmReanalyzeImage} disabled={captureBusy} />
    {visionReview ? <View style={styles.aiCard}><Text style={styles.aiTitle}>识别与分析草稿 · 请核对</Text>
      <VisionFields key={visionReview.draft_id} value={visionReview.draft} onChange={reviewVisionFields} disabled={captureBusy} />
    </View> : <><Text style={styles.aiLabel}>内容（识别失败时可手动填写）</Text>
      <TextInput style={[styles.input, styles.multiline]} multiline maxLength={12000} value={manualContent} onChangeText={setManualContent} editable={!captureBusy} placeholder="输入你要保存的内容" /></>}
    {reminderDay && <Text style={styles.status}>提醒日期建议：{reminderDay}{reminderTime ? ` · ${reminderTime}` : " · 未识别到具体时间"}。保存后可在详情页修改并设置提醒。</Text>}
    {(captureBusy || ocrBusy) && <ActivityIndicator />}{captureError && <Text style={styles.error}>{captureError}</Text>}{imageError && <Text style={styles.error}>{imageError}</Text>}
    <Button title="确认并保存" onPress={finalizeCapture} disabled={captureBusy || ocrBusy || !captureTitle.trim()} />
    <Button title="稍后继续（保留草稿）" onPress={() => setScreen("list")} disabled={captureBusy} />
  </ScrollView></SafeAreaView>;
  if (screen === "form" && selected?.source_image_path) return <SafeAreaView style={styles.container}><ScrollView>
    <Text style={styles.title}>编辑{editVision?.category ? ` · ${editVision.category}` : "图片 Memory"}</Text>
    <Text style={styles.aiLabel}>标题</Text><TextInput style={styles.input} value={draft.title} onChangeText={(title) => setDraft({ ...draft, title })} />
    {editVision && <View style={styles.aiCard}><Text style={styles.aiTitle}>已确认的分析字段</Text><VisionFields value={editVision} onChange={editVisionFields} preferred={categoryFields(editVision.category)} /></View>}
    <View style={styles.reminderCard}><Text style={styles.aiTitle}>一次性提醒</Text>
      <Button title="选择日期" onPress={() => { setPickerValue(reminderDateTime(reminderDay, reminderTime) || (reminderDay ? new Date(`${reminderDay}T12:00:00`) : new Date(Date.now() + 86400000))); setPickerMode("date"); }} />
      <Button title="选择时间" onPress={() => { setPickerValue(reminderDateTime(reminderDay, reminderTime) || (reminderDay ? new Date(`${reminderDay}T12:00:00`) : new Date())); setPickerMode("time"); }} />
      {pickerMode && <><DateTimePicker key={pickerMode} value={pickerValue} mode={pickerMode} display="spinner" onChange={(event, value) => { if (event.type !== "dismissed" && value) setPickerValue(value); }} onDismiss={() => setPickerMode(null)} /><Button title="完成选择" onPress={() => { const day = pickerMode === "date" ? localDay(pickerValue) : reminderDay; const time = pickerMode === "time" ? localTime(pickerValue) : reminderTime; setReminderDay(day); setReminderTime(time); reminderDrafts.current[selected.id] = { day, time }; setReminderTouched(true); setPickerMode(null); }} /></>}
      {reminderDay && <Text style={styles.selectedTime}>提醒日期（{selected.reminder_at ? "已设置" : "未保存"}）：{reminderDay}</Text>}
      {reminderTime && <Text style={styles.selectedTime}>具体时间：{reminderTime}</Text>}
      {reminderDay && !reminderTime && <Text style={styles.warning}>尚无具体时间。请选择时间后才能设置提醒。</Text>}
      <Button title={selected.reminder_at ? "更新提醒" : "设置提醒"} onPress={setReminder} />
      {selected.reminder_at && <Button title="取消提醒" color="#b00020" onPress={cancelReminder} />}
      {reminderError && <Text style={styles.error}>{reminderError}</Text>}
    </View>
    <Button title="保存修改" onPress={save} /><Button title="取消" onPress={() => setScreen("detail")} />
  </ScrollView></SafeAreaView>;
  if (screen === "form") return <Form draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setScreen(selected ? "detail" : "list")} editing={!!selected} />;
  if (screen === "detail" && selected) return <SafeAreaView style={styles.container}><ScrollView contentContainerStyle={styles.scrollContent}><Text style={styles.eyebrow}>MEMORY 详情</Text><Text style={styles.title}>{selected.title}</Text><Text style={styles.meta}>{selected.category || "未分类"}</Text><TagChips tags={selected.tags} /><View style={styles.contentCard}><Text style={styles.sectionTitle}>最终 Memory 内容</Text><Text style={styles.content}>{selected.confirmed_content}</Text></View><View style={styles.imageCard}><Text style={styles.aiTitle}>本地图片</Text><Button title={imageLoading ? "处理中…" : "选择图片并解析"} onPress={chooseImage} disabled={imageLoading || visionBusy} />{selected.source_image_filename && <Text style={styles.supportingText}>已上传：{selected.source_image_filename}</Text>}{selected.source_image_path && <><Button title={showSavedImage ? "收起图片" : "展开图片"} onPress={() => setShowSavedImage(!showSavedImage)} />{showSavedImage && <Image style={styles.sourceImage} source={{ uri: `${API_URL}/memories/${selected.id}/image/file` }} resizeMode="contain" />}</>}{selected.source_image_path && <Button title="使用 OpenAI 重新识别并分析" onPress={confirmReanalyzeImage} disabled={captureBusy || imageLoading} />}
{visionReview && <View style={styles.aiCard}><Text style={styles.aiTitle}>识别与分析草稿 · 请核对</Text>
  <Text style={styles.aiLabel}>标题</Text><TextInput style={styles.input} value={captureTitle} onChangeText={(title) => { setCaptureTitle(title); titleTouched.current = true; }} maxLength={200} />
  <VisionFields key={visionReview.draft_id} value={visionReview.draft} onChange={reviewVisionFields} disabled={captureBusy} />
  <Button title="确认并保存分析结果" onPress={acceptVision} disabled={captureBusy} />
  <Button title="拒绝草稿" onPress={rejectVision} disabled={captureBusy} /></View>}
{captureError && <Text style={styles.error}>{captureError}</Text>}
{visionMessage && <Text style={styles.warning}>{visionMessage}</Text>}
{imageError && <Text style={styles.error}>{imageError}</Text>}
{selected.confirmed_vision && <View><Text style={styles.aiTitle}>最终 Memory 字段</Text><VisionFields value={JSON.parse(selected.confirmed_vision)} disabled /></View>}
</View><View style={styles.reminderCard}><Text style={styles.aiTitle}>一次性提醒</Text>
<Button title="选择日期" onPress={() => { setPickerValue(reminderDateTime(reminderDay, reminderTime) || (reminderDay ? new Date(`${reminderDay}T12:00:00`) : new Date(Date.now() + 86400000))); setPickerMode("date"); }} />
<Button title="选择时间" onPress={() => { setPickerValue(reminderDateTime(reminderDay, reminderTime) || (reminderDay ? new Date(`${reminderDay}T12:00:00`) : new Date())); setPickerMode("time"); }} />
{pickerMode && <><DateTimePicker key={pickerMode} value={pickerValue} mode={pickerMode} display="spinner" onChange={(event, value) => { if (event.type !== "dismissed" && value) setPickerValue(value); }} onDismiss={() => setPickerMode(null)} /><Button title="完成选择" onPress={() => { const day = pickerMode === "date" ? localDay(pickerValue) : reminderDay; const time = pickerMode === "time" ? localTime(pickerValue) : reminderTime; setReminderDay(day); setReminderTime(time); reminderDrafts.current[selected.id] = { day, time }; setReminderTouched(true); setPickerMode(null); }} /></>}
{reminderDay && <Text style={styles.selectedTime}>提醒日期（{selected.reminder_at ? "已设置" : "未保存"}）：{reminderDay}</Text>}
{reminderTime && <Text style={styles.selectedTime}>具体时间：{reminderTime}</Text>}
{reminderDay && !reminderTime && <Text style={styles.warning}>尚无具体时间。请选择时间后才能设置提醒。</Text>}
<Button title={selected.reminder_at ? "更新提醒" : "设置提醒"} onPress={setReminder} />
{selected.reminder_at && <Button title="取消提醒" color="#b00020" onPress={cancelReminder} />}
{reminderError && <Text style={styles.error}>{reminderError}</Text>}</View>{!selected.source_image_path && <><Button title={aiLoading ? "生成中…" : "生成 AI 草稿"} onPress={generateAI} disabled={aiLoading} />{aiDraft?.draft && <View style={styles.aiCard}><Text style={styles.aiTitle}>AI 草稿（需要你确认）</Text><Text style={styles.aiLabel}>摘要</Text>{reviewEditing ? <TextInput style={[styles.input, styles.multiline]} multiline value={aiDraft.draft.summary} onChangeText={(summary) => setAiDraft({ ...aiDraft, draft: { ...aiDraft.draft!, summary } })} /> : <Text style={styles.content}>{aiDraft.draft.summary}</Text>}<Text style={styles.aiLabel}>分类：{aiDraft.draft.category.value}（置信度 {Math.round(aiDraft.draft.category.confidence * 100)}%，{aiDraft.draft.category.uncertain ? "不确定" : "较确定"}）</Text><Text style={styles.aiLabel}>标签：{aiDraft.draft.tags.map((tag) => tag.value).join(", ")}</Text>{aiDraft.warnings.map((warning) => <Text key={warning} style={styles.warning}>提示：{warning}</Text>)}<Button title="接受 AI 草稿" onPress={acceptAI} /><Button title="编辑草稿内容" onPress={() => setReviewEditing(true)} /><Button title="拒绝 AI 草稿" color="#b00020" onPress={rejectAI} /></View>}</>}<Button title="编辑" onPress={openEdit} disabled={visionBusy} /><Button title="删除" color="#b00020" onPress={remove} disabled={visionBusy} /><Button title="返回列表" onPress={() => setScreen("list")} disabled={visionBusy} /></ScrollView></SafeAreaView>;
  const tagChoices = availableTags(memories);
  const displayedMemories = filterByTags(searchResults ?? memories, selectedTags);
  const toggleTag = (tag: string) => setSelectedTags((tags) => tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag]);
  const clearFilters = async () => { setSelectedTags([]); await clearSearch(); };
  return <SafeAreaView style={styles.container}><Text style={styles.eyebrow}>本地资料库</Text><Text style={styles.title}>我的 Memories</Text><View style={styles.searchPanel}><View style={styles.searchRow}><TextInput style={styles.searchInput} placeholder="搜索标题、内容或标签" placeholderTextColor="#78828c" value={searchKeyword} onChangeText={(value) => { setSearchKeyword(value); if (!value.trim()) setSearchResults(null); setSearchError(null); }} onSubmitEditing={search} returnKeyType="search" /><Button title="搜索" onPress={search} /></View>{searchResults !== null && <Button title="清除搜索" onPress={clearSearch} />}
<View style={styles.tagFilter}><Button title={showTagChoices ? "收起标签" : `选择标签${selectedTags.length ? ` (${selectedTags.length})` : ""}`} onPress={() => setShowTagChoices(!showTagChoices)} />
{selectedTags.length > 0 && <View style={styles.tagRow}>{selectedTags.map((tag) => <TouchableOpacity key={tag} style={styles.selectedTag} onPress={() => toggleTag(tag)}><Text style={styles.selectedTagText} numberOfLines={1}>✕ {tag}</Text></TouchableOpacity>)}<Button title="清除全部" onPress={() => setSelectedTags([])} /></View>}
{showTagChoices && (tagChoices.length ? <View style={styles.tagRow}>{tagChoices.map((tag) => <TouchableOpacity key={tag} style={selectedTags.includes(tag) ? styles.selectedTag : styles.tagChoice} onPress={() => toggleTag(tag)}><Text style={selectedTags.includes(tag) ? styles.selectedTagText : styles.tagText} numberOfLines={1}>{selectedTags.includes(tag) ? "✓ " : ""}{tag}</Text></TouchableOpacity>)}</View> : <Text style={styles.status}>还没有可选标签。给 Memory 添加标签后即可筛选。</Text>)}</View></View>
<View style={styles.actionPanel}><Button title="新建 Memory" onPress={openCreate} /><View style={styles.actionRow}><View style={styles.actionItem}><Button title="拍照" onPress={() => chooseNewImage("camera")} disabled={captureBusy} /></View><View style={styles.actionItem}><Button title="从相册选择" onPress={() => chooseNewImage("library")} disabled={captureBusy} /></View></View></View>
{(loading || searchLoading) && <View style={styles.loadingState}><ActivityIndicator color="#27634a" /><Text style={styles.status}>{searchLoading ? "正在搜索…" : "正在加载…"}</Text></View>}
{(loadError || searchError) && <View style={styles.errorCard}><Text style={styles.error}>{loadError || searchError}</Text><Button title="重试" onPress={searchError ? search : load} /></View>}
{!loading && !loadError && <Text style={styles.resultCount}>{(searchResults !== null || selectedTags.length > 0) ? (displayedMemories.length ? `找到 ${displayedMemories.length} 条记录` : "没有符合关键词和标签的 Memory") : (memories.length ? `${memories.length} 条记录` : "还没有 Memory")}</Text>}
{!loading && !loadError && !displayedMemories.length ? <View style={styles.emptyState}><Text style={styles.emptyTitle}>{searchResults !== null || selectedTags.length > 0 ? "没有匹配结果" : "从第一条 Memory 开始"}</Text><Text style={styles.supportingText}>{searchResults !== null || selectedTags.length > 0 ? "换一个关键词或清除筛选后再试。" : "你可以手动新建，也可以拍照或从相册导入。"}</Text>{(searchResults !== null || selectedTags.length > 0) && <Button title="清除全部筛选" onPress={clearFilters} />}</View> : <FlatList data={displayedMemories} contentContainerStyle={styles.listContent} keyExtractor={(item) => String(item.id)} renderItem={({ item }) => <TouchableOpacity style={styles.card} onPress={() => openDetail(item)} activeOpacity={0.72}><View style={styles.cardHeader}><Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>{item.confirmation_status === "draft" && <Text style={styles.draftBadge}>待确认</Text>}</View>{item.category && <Text style={styles.cardMeta}>{item.category}</Text>}<Text style={styles.cardContent} numberOfLines={2}>{item.confirmed_content || (item.source_image_path ? "图片草稿，点开继续审核" : item.original_text)}</Text><TagChips tags={item.tags} compact /></TouchableOpacity>} refreshing={loading} onRefresh={load} />}</SafeAreaView>;
}

const visionLabels: Record<VisionFieldKey, string> = { summary: "摘要", category: "分类", tags: "标签", amount: "金额", currency: "币种（ISO，如 CNY）", date: "日期（YYYY-MM-DD）", time: "具体时间（HH:MM）", due_date: "到期日（YYYY-MM-DD）", institution: "机构名称", location_name: "地点名称", location_address: "地址", location_purpose: "地点用途" };

function TagChips({ tags, compact = false }: { tags: string[]; compact?: boolean }) {
  const visibleTags = displayTags(tags);
  if (!visibleTags.length) return null;
  return <View style={[styles.tagRow, compact && styles.compactTagRow]}>{visibleTags.map((tag) => <View key={tag} style={styles.tagChip}><Text style={styles.tagText} numberOfLines={1} ellipsizeMode="tail">{tag}</Text></View>)}</View>;
}

function VisionFields({ value, onChange, disabled = false, preferred = [] }: { value: VisionDraft; onChange?: (draft: VisionDraft) => void; disabled?: boolean; preferred?: VisionFieldKey[] }) {
  const [visible, setVisible] = useState<VisionFieldKey[]>(() => [...new Set([...preferred, ...visibleVisionFields(value)])]);
  const [adding, setAdding] = useState(false);
  const [removed, setRemoved] = useState<VisionFieldKey[]>([]);
  useEffect(() => { setVisible((fields) => [...new Set([...fields, ...preferred, ...visibleVisionFields(value)])].filter((key) => !removed.includes(key))); }, [value, preferred.join(","), removed]);
  const available = visionKeys.filter((key) => !visible.includes(key));
  const change = (key: VisionFieldKey, text: string) => onChange?.({ ...value, [key]: key === "tags" ? text.split(",").map((tag) => tag.trim()).filter(Boolean) : text || null });
  const removeField = (key: VisionFieldKey) => { change(key, ""); setRemoved((fields) => [...fields, key]); setVisible((fields) => fields.filter((field) => field !== key)); };
  return <View>
    {visible.length === 0 && <Text style={styles.status}>没有提取到可用字段，可在下方添加。</Text>}
    {visible.map((key) => <View key={key}>
      <View style={styles.fieldRow}><Text style={styles.aiLabel}>{visionLabels[key]}{value.uncertain_fields.includes(key) ? " · 不确定" : ""}</Text>{!disabled && <Button title="移除" onPress={() => removeField(key)} />}</View>
      {disabled ? <Text style={styles.content}>{key === "tags" ? value.tags.join(", ") : value[key]}</Text> : <TextInput style={[styles.input, key === "summary" && styles.multiline]} editable={!!onChange} value={key === "tags" ? value.tags.join(", ") : value[key] || ""} onChangeText={(text) => change(key, text)} multiline={key === "summary"} placeholder="请输入" />}
    </View>)}
    {!disabled && available.length > 0 && <><Button title={adding ? "收起添加字段" : "添加字段 ▾"} onPress={() => setAdding(!adding)} />{adding && available.map((key) => <Button key={key} title={visionLabels[key]} onPress={() => { setRemoved((fields) => fields.filter((field) => field !== key)); setVisible((fields) => [...fields, key]); setAdding(false); }} />)}</>}
    {value.warnings.map((warning, index) => <Text key={index} style={styles.warning}>提示：{warning}</Text>)}
  </View>;
}

function Form({ draft, setDraft, onSave, onCancel, editing }: { draft: Draft; setDraft: (draft: Draft) => void; onSave: () => void; onCancel: () => void; editing: boolean }) {
  const field = (key: keyof Draft, label: string, placeholder: string, multiline = false) => <View><Text style={styles.fieldLabel}>{label}</Text><TextInput style={[styles.input, multiline && styles.multiline]} placeholder={placeholder} placeholderTextColor="#78828c" value={draft[key]} onChangeText={(value) => setDraft({ ...draft, [key]: value })} multiline={multiline} /></View>;
  const formTags = draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  return <SafeAreaView style={styles.container}><ScrollView contentContainerStyle={styles.scrollContent}><Text style={styles.eyebrow}>{editing ? "更新资料" : "添加资料"}</Text><Text style={styles.title}>{editing ? "编辑 Memory" : "新建 Memory"}</Text><View style={styles.formCard}>{field("title", "标题", "输入清晰、易识别的标题")}{field("original_text", "内容", "记录账单、收据或通知的关键信息", true)}{field("category", "分类", "例如：账单、收据、通知")}{field("tags", "标签", "使用逗号分隔多个标签")}<TagChips tags={formTags} /></View><View style={styles.formActions}><Button title="保存" onPress={onSave} /><Button title="取消" onPress={onCancel} /></View></ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 18, paddingTop: 16, backgroundColor: "#f5f7f6" },
  scrollContent: { paddingBottom: 32 },
  eyebrow: { color: "#27634a", fontSize: 12, fontWeight: "700", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 4 },
  title: { color: "#17201c", fontSize: 29, lineHeight: 35, fontWeight: "700", marginBottom: 14 },
  sectionTitle: { color: "#17201c", fontSize: 16, fontWeight: "700", marginBottom: 10 },
  tagFilter: { gap: 8, marginTop: 8 },
  tagRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 7, marginBottom: 12 },
  compactTagRow: { marginTop: 12, marginBottom: 0 },
  tagChip: { maxWidth: "100%", borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: "#e7f1ec", borderWidth: 1, borderColor: "#c9ded3" },
  tagChoice: { maxWidth: "100%", borderWidth: 1, borderColor: "#cbd3cf", backgroundColor: "#ffffff", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  selectedTag: { maxWidth: "100%", borderWidth: 1, borderColor: "#4e8068", backgroundColor: "#dcece4", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  tagText: { color: "#315c48", fontSize: 13, flexShrink: 1 },
  selectedTagText: { color: "#1f513a", fontSize: 13, fontWeight: "600", flexShrink: 1 },
  searchPanel: { backgroundColor: "#ffffff", borderRadius: 16, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: "#e1e6e3" },
  searchRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  searchInput: { flex: 1, minWidth: 0, borderWidth: 1, borderColor: "#cbd3cf", backgroundColor: "#fbfcfb", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: "#17201c" },
  actionPanel: { backgroundColor: "#ffffff", borderRadius: 16, padding: 12, gap: 8, marginBottom: 10, borderWidth: 1, borderColor: "#e1e6e3" },
  actionRow: { flexDirection: "row", gap: 8 },
  actionItem: { flex: 1 },
  loadingState: { alignItems: "center", paddingVertical: 18 },
  status: { color: "#65716b", lineHeight: 20, marginVertical: 8 },
  resultCount: { color: "#65716b", fontSize: 13, fontWeight: "600", marginVertical: 8 },
  error: { color: "#9f2430", lineHeight: 20 },
  errorCard: { backgroundColor: "#fff1f2", borderColor: "#f0c4c9", borderWidth: 1, borderRadius: 12, padding: 12, gap: 8, marginVertical: 8 },
  emptyState: { backgroundColor: "#ffffff", alignItems: "center", borderRadius: 16, borderWidth: 1, borderColor: "#e1e6e3", padding: 24, gap: 8 },
  emptyTitle: { color: "#26332d", fontSize: 18, fontWeight: "700" },
  supportingText: { color: "#65716b", lineHeight: 20 },
  listContent: { paddingBottom: 28 },
  card: { padding: 16, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#e1e6e3", borderRadius: 16, marginBottom: 10, shadowColor: "#18231e", shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  cardTitle: { color: "#17201c", flex: 1, fontSize: 18, lineHeight: 23, fontWeight: "700" },
  cardMeta: { color: "#527060", fontSize: 13, fontWeight: "600", marginTop: 5 },
  cardContent: { color: "#4d5953", fontSize: 15, lineHeight: 22, marginTop: 8 },
  draftBadge: { color: "#7a5200", backgroundColor: "#fff2ce", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 12, fontWeight: "700" },
  meta: { color: "#65716b", marginBottom: 10 },
  contentCard: { backgroundColor: "#ffffff", borderRadius: 16, padding: 16, marginVertical: 12, borderWidth: 1, borderColor: "#e1e6e3" },
  content: { color: "#27322d", fontSize: 16, lineHeight: 25, marginBottom: 10 },
  selectedTime: { fontSize: 15, color: "#245b3f", marginVertical: 5 },
  imageCard: { borderWidth: 1, borderColor: "#c9ded3", backgroundColor: "#f9fcfa", borderRadius: 16, padding: 15, marginVertical: 12, gap: 9 },
  reminderCard: { borderWidth: 1, borderColor: "#c8d9e7", backgroundColor: "#f8fbfd", borderRadius: 16, padding: 15, marginVertical: 12, gap: 9 },
  sourceImage: { width: "100%", height: 260, marginVertical: 10, borderRadius: 12, backgroundColor: "#edf0ee" },
  aiCard: { borderWidth: 1, borderColor: "#ead49c", backgroundColor: "#fffcf4", borderRadius: 16, padding: 15, marginVertical: 12, gap: 9 },
  aiTitle: { color: "#26332d", fontSize: 18, fontWeight: "700" },
  aiLabel: { color: "#3d4943", fontSize: 14, fontWeight: "600", marginBottom: 6 },
  fieldLabel: { color: "#35413b", fontSize: 14, fontWeight: "700", marginBottom: 6 },
  fieldRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  warning: { color: "#805800", backgroundColor: "#fff7df", padding: 9, borderRadius: 8, marginBottom: 8 },
  input: { color: "#17201c", backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#cbd3cf", borderRadius: 10, padding: 12, fontSize: 16, marginBottom: 14 },
  multiline: { minHeight: 140, textAlignVertical: "top" },
  formCard: { backgroundColor: "#ffffff", borderRadius: 16, padding: 16, borderWidth: 1, borderColor: "#e1e6e3" },
  formActions: { gap: 8, marginTop: 14 },
});
