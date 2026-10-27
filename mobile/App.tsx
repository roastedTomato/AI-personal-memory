import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Image, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import DateTimePicker from "@react-native-community/datetimepicker";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import Markdown from "react-native-markdown-display";
import { visionRequestError } from "./apiErrors";
import { availableTags, displayTags, filterByTags } from "./tagFilter";
import { API_URL, request } from "./api/client";
import { mapVisionEnvelope, visibleVisionFields, visionKeys, reminderSuggestion, suggestReminderIfUntouched, emptyVisionDraft, categoryFields, type VisionDraft, type VisionEnvelope, type VisionFieldKey } from "./visionDraft";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const restoreVisionDraft = (raw: string): VisionEnvelope | null => mapVisionEnvelope(JSON.parse(raw));
type Memory = { image_text_draft?: string | null; confirmed_image_text?: string | null; vision_draft?: string | null; vision_metadata?: string | null; confirmed_vision?: string | null; id: number; title: string; original_text: string; confirmed_content: string; category?: string | null; tags: string[]; event_date?: string | null; due_date?: string | null; location?: string | null; amount?: number | string | null; currency?: string | null; source_type: string; confirmation_status: string; reminder_at?: string | null; reminder_notification_id?: string | null; ocr_text?: string | null; ocr_status?: string | null; ocr_error?: string | null; ocr_duration_ms?: number | null; source_image_path?: string | null; source_image_filename?: string | null; source_image_mime_type?: string | null; source_image_size?: number | null; created_at: string; updated_at: string };
type AIDraftField = { value: string; confidence: number; uncertain: boolean };
type AIDraft = { summary: string; category: AIDraftField; tags: AIDraftField[] };
type AIAssistResponse = { memory_id: number; ai_status: string; draft?: AIDraft; warnings: string[]; error?: string | null };
type Draft = { title: string; original_text: string; category: string; tags: string };
const emptyDraft: Draft = { title: "", original_text: "", category: "", tags: "" };
const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const localTime = (date: Date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
const memoryDate = (value: string) => new Intl.DateTimeFormat("en-NZ", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
const reminderDateTime = (day: string | null, time: string | null): Date | null => {
  if (!day || !time) return null;
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const value = new Date(year, month - 1, date, hour, minute);
  return localDay(value) === day && localTime(value) === time ? value : null;
};

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
  const name = asset.fileName || "memory-image.jpg";
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

function Button({ title, onPress, disabled = false, color, variant = "secondary", compact = false, nowrap = false }: { title: string; onPress: () => void; disabled?: boolean; color?: string; variant?: "primary" | "secondary"; compact?: boolean; nowrap?: boolean }) {
  const destructive = color === "#b00020";
  const singleLine = nowrap || title.startsWith("+");
  return <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled }} activeOpacity={0.7} disabled={disabled} onPress={onPress} style={[styles.button, singleLine && styles.singleLineButton, variant === "primary" && styles.primaryButton, compact && styles.compactButton, destructive && styles.destructiveButton, disabled && styles.disabledButton]}><Text style={[styles.buttonText, variant === "primary" && styles.primaryButtonText, destructive && styles.destructiveButtonText, disabled && styles.disabledButtonText]} numberOfLines={singleLine ? 1 : 2}>{title}</Text></TouchableOpacity>;
}

function MarkdownText({ value }: { value: string }) {
  return <Markdown style={markdownStyles}>{value}</Markdown>;
}

function AppContent() {
  const [screen, setScreen] = useState<"list" | "form" | "detail" | "capture" | "ask">("list");
  const [question, setQuestion] = useState("");
  const [questionBusy, setQuestionBusy] = useState(false);
  const questionLock = useRef(false);
  const [answer, setAnswer] = useState<{ status: string; answer: string; sources: { memory_id: number; title: string; event_date: string | null }[] } | null>(null);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const askMemories = () => {
    if (!question.trim() || questionLock.current) return;
    Alert.alert("Ask your Memories", "Your question and up to five matching confirmed Memories will be sent to OpenAI to answer. Continue?", [
      { text: "Cancel", style: "cancel" },
      { text: "Continue", onPress: async () => {
        if (questionLock.current) return;
        questionLock.current = true; setQuestionBusy(true); setQuestionError(null);
        try {
          setAnswer(await request("/memories/query", { method: "POST", body: JSON.stringify({ question: question.trim(), consent: true, today: localDay(new Date()) }) }));
        } catch (error) { setQuestionError(`Unable to answer: ${String(error)} You can still use keyword search.`); }
        finally { questionLock.current = false; setQuestionBusy(false); }
      } },
    ]);
  };
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
  const [reminderMessage, setReminderMessage] = useState<string | null>(null);
  const [reminderBusy, setReminderBusy] = useState(false);
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

  const load = async () => { setLoading(true); setLoadError(null); try { setMemories(await request("/memories")); } catch { setLoadError("Unable to load Memories. Check your connection and try again."); } finally { setLoading(false); } };
  const search = async () => { const keyword = searchKeyword.trim(); if (!keyword) return clearSearch(); setSearchLoading(true); setSearchError(null); try { setSearchResults(await request(`/memories?q=${encodeURIComponent(keyword)}`)); } catch (e) { setSearchError("Search failed. Please try again."); } finally { setSearchLoading(false); } };
  const clearSearch = async () => { setSearchKeyword(""); setSearchResults(null); setSearchError(null); await load(); };
  useEffect(() => { Notifications.setNotificationChannelAsync("memory-reminders", { name: "Memory reminders", importance: Notifications.AndroidImportance.HIGH, sound: "default" }).catch(() => {}); load(); AsyncStorage.getItem("memory-reminder-notifications").then((value) => { if (value) setNotificationMap(JSON.parse(value)); }); const subscription = Notifications.addNotificationResponseReceivedListener(async (response) => { const memoryId = response.notification.request.content.data?.memoryId; if (memoryId) { try { const value = await request(`/memories/${memoryId}`); setSelected(value); const current = value.reminder_at ? new Date(value.reminder_at) : null; setReminderDay(current ? localDay(current) : null); setReminderTime(current ? localTime(current) : null); setReminderTouched(false); setScreen("detail"); } catch { Alert.alert("Reminder", "The linked Memory is no longer available."); } } }); return () => subscription.remove(); }, []);
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
    setReminderTouched(!!manual); setShowSavedImageText(false); setShowSavedOcrText(false); setShowSavedImage(false); setReminderError(null); setReminderMessage(null); setCaptureTitle(memory.title); titleTouched.current = memory.confirmation_status !== "draft"; setManualContent(""); setCaptureError(null); setScreen(memory.confirmation_status === "draft" ? "capture" : "detail"); };
  const updateReminderFromDraft = (fields: VisionDraft) => {
    if (!selected || selected.reminder_at || reminderTouched || reminderDrafts.current[selected.id]) return;
    const suggestion = reminderSuggestion(fields);
    setReminderDay(suggestion?.day ?? null);
    setReminderTime(suggestion?.time ?? null);
  };
  const editVisionFields = (fields: VisionDraft) => { setEditVision(fields); updateReminderFromDraft(fields); };
  const reviewVisionFields = (fields: VisionDraft) => { setVisionReview((current) => current ? { ...current, draft: fields } : null); updateReminderFromDraft(fields); };
  const openEdit = () => { if (!selected) return; setDraft({ title: selected.title, original_text: selected.original_text, category: selected.category || "", tags: selected.tags.join(", ") }); setEditContent(selected.confirmed_content); const fields = selected.confirmed_vision ? mapVisionEnvelope({ draft_id: "confirmed", draft: JSON.parse(selected.confirmed_vision) })?.draft ?? emptyVisionDraft() : { ...emptyVisionDraft(), summary: selected.confirmed_content || null, category: selected.category || null, tags: selected.tags }; setEditVision(fields); if (!selected.reminder_at && !reminderTouched && !reminderDrafts.current[selected.id]) { const suggestion = reminderSuggestion(fields); if (suggestion) { setReminderDay(suggestion.day); setReminderTime(suggestion.time); } } setScreen("form"); };
  const save = async () => { if (selected?.source_image_path) { if (!draft.title.trim()) return Alert.alert("Enter a title"); try { const value = await request(`/memories/${selected.id}/image/confirmed`, { method: "PATCH", body: JSON.stringify({ title: draft.title.trim(), confirmed_content: editVision?.summary ?? editContent, draft: editVision }) }); setSelected(value); await load(); setScreen("detail"); } catch (e) { Alert.alert("Save failed", visionRequestError(e)); } return; } if (!draft.title.trim() || !draft.original_text.trim()) return Alert.alert("Enter a title and content"); const payload = { title: draft.title.trim(), original_text: draft.original_text.trim(), confirmed_content: selected && draft.original_text.trim() === selected.original_text ? selected.confirmed_content : draft.original_text.trim(), category: draft.category.trim() || null, tags: draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean) }; try { const value = selected ? await request(`/memories/${selected.id}`, { method: "PATCH", body: JSON.stringify(payload) }) : await request("/memories", { method: "POST", body: JSON.stringify(payload) }); setSelected(value); await load(); setScreen("detail"); } catch (e) { Alert.alert("Save failed", String(e)); } };
  const remove = () => { if (!selected) return; Alert.alert("Delete Memory", "Are you sure you want to delete this Memory?", [{ text: "Cancel" }, { text: "Delete", style: "destructive", onPress: async () => { try { await request(`/memories/${selected.id}`, { method: "DELETE" }); setSelected(null); await load(); setScreen("list"); } catch (e) { Alert.alert("Delete failed", String(e)); } } }]); };
  const chooseImage = async () => {
    if (!selected) return;
    setImageError(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) { setImageError("Photo library access was denied. You can still edit the Memory manually."); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    Alert.alert("Process this image?", "Text is recognized on this device, then sent to OpenAI for analysis. The image is not sent during this first pass.", [
      { text: "Cancel", style: "cancel" },
      { text: "Agree and Process", onPress: async () => {
    setImageLoading(true);
    try {
      const prepared = await uploadableImage(asset);
      const value = await uploadImage(selected.id, prepared.uri, prepared.name, prepared.type);
      setSelected(value); setVisionReview(null); setVisionMessage(null); setShowImageDraft(true); setShowSavedImageText(false); setShowSavedOcrText(false); setShowSavedImage(false); setImageText(""); setConfirmedText(null); setTextWarnings([]); setOcrText(""); setOcrMessage(null);
      const ocr = await request(`/memories/${value.id}/image/ocr`, { method: "POST" });
      setOcrText(ocr.text || ""); setImageText(ocr.text || "");
      setSelected((current) => current?.id === value.id ? { ...current, ocr_text: ocr.text, ocr_status: ocr.status, ocr_duration_ms: ocr.duration_ms } : current);
      if (ocr.status === "completed" && ocr.text?.trim()) await analyzeCaptureText(value, ocr.text);
      else setCaptureError("Local OCR found no text. The image and existing content were preserved for manual editing.");
    } catch (e) { console.error("image upload or parse failed", e); setImageError("Image upload or analysis failed. You can still save the Memory manually."); } finally { setImageLoading(false); }
      } },
    ]);
  };

  const analyzeCaptureText = async (memory: Memory, text: string) => {
    if (!text.trim()) return;
    try {
      const result = await request(`/memories/${memory.id}/image/analyze-draft`, { method: "POST", body: JSON.stringify({ consent: true, request_id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, text }) });
      if (result.metadata?.status === "failed") {
        setCaptureError(`AI analysis failed: ${visionErrors[result.metadata.error] || result.metadata.error}. The image and OCR result were preserved for review.`);
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
    } catch (error) { setCaptureError(`AI analysis failed: ${visionRequestError(error)} You can continue editing and save manually.`); }
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
          setCaptureError("Local OCR found no text. The image was preserved; enter content manually or analyse it again.");
        } else await analyzeCaptureText(memory, result.text);
      } catch (error) { setCaptureError("Local OCR failed. The image was preserved for manual entry."); }
    } catch (error) { Alert.alert("Unable to create image Memory", String(error)); }
    finally { captureLock.current = false; setCaptureBusy(false); }
  };

  const chooseNewImage = async (source: "camera" | "library") => {
    if (captureLock.current) return;
    try {
    const permission = source === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return Alert.alert("Photo access required", source === "camera" ? "Allow camera access to continue." : "Allow photo library access to continue.");
    const result = source === "camera"
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    Alert.alert("Process this image?", "Text is recognized on this device, then sent to OpenAI for analysis. The image itself is not sent, and manual saving remains available.", [
      { text: "Cancel", style: "cancel" },
      { text: "Agree and Process", onPress: () => startImageMemory(asset) },
    ]);
    } catch (error) { Alert.alert("Unable to open image", String(error)); }
  };

  const reanalyzeImage = async () => {
    if (!selected || captureLock.current) return;
    const memory = selected;
    captureLock.current = true; setCaptureBusy(true); setCaptureError(null); setVisionMessage(null);
    try {
      const result = await request(`/memories/${memory.id}/image/reanalyze`, { method: "POST", body: JSON.stringify({ consent: true, request_id: `${Date.now()}-${Math.random().toString(36).slice(2)}` }) });
      if (result.metadata?.status === "failed") {
        setCaptureError(`OpenAI image analysis failed: ${visionErrors[result.metadata.error] || result.metadata.error}. The original image and saved content were preserved.`);
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
    } catch (error) { setCaptureError(`OpenAI image analysis failed: ${visionRequestError(error)} The original image and saved content were preserved.`); }
    finally { captureLock.current = false; setCaptureBusy(false); }
  };
  const confirmReanalyzeImage = () => Alert.alert("Send the original image to OpenAI?", "This explicit action sends the image in one model request. You must still review the result.", [
    { text: "Cancel", style: "cancel" }, { text: "Agree and Reanalyse", onPress: reanalyzeImage },
  ]);

  const finalizeCapture = async () => {
    if (!selected || captureLock.current || !captureTitle.trim()) return Alert.alert("Enter a title");
    captureLock.current = true; setCaptureBusy(true);
    try {
      const value = await request(`/memories/${selected.id}/image/finalize`, { method: "POST", body: JSON.stringify({
        title: captureTitle.trim(), text: visionReview ? "" : manualContent, source_image_path: selected.source_image_path,
        draft_id: visionReview?.draft_id ?? null, draft: visionReview?.draft ?? null,
      }) });
      setSelected(value); setVisionReview(null); setShowImageDraft(false); setScreen("detail");
      await load();
    } catch (error) { setCaptureError(`Save failed: ${visionRequestError(error)} The draft and image remain editable.`); }
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
      if (result.status !== "completed") setImageError(`No text was recognized (${result.error || result.status}). The original image was preserved for manual entry.`);
    } catch { setImageError("The OCR request failed. The original image was preserved for manual entry or editing."); }
    finally { setOcrBusy(false); }
  };
  const parseOCR = async () => {
    if (!selected || !ocrText.trim() || ocrBusy) return;
    setOcrBusy(true); setImageError(null);
    try { setAiDraft(await request(`/memories/${selected.id}/image/parse`, { method: "POST", body: JSON.stringify({ text: ocrText }) })); setReviewEditing(false); }
    catch { setImageError("Draft generation failed. Recognized text was preserved for manual editing."); }
    finally { setOcrBusy(false); }
  };

  const visionErrors: Record<string, string> = { key_not_configured: "The backend API key is not configured", authentication_failed: "The OpenAI key or permissions are invalid", insufficient_quota: "OpenAI quota is unavailable", rate_limited: "OpenAI is rate limited; try again later", timeout: "Analysis timed out and was not retried", network_error: "Unable to connect to OpenAI", refused: "The model declined to analyse this image", invalid_output: "The model returned an invalid result", incomplete_output: "The model response was incomplete", provider_error: "The OpenAI request failed", image_size_limit: "Image analysis supports files up to 5 MB", unsupported_image: "The image format is invalid" };
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
        setVisionMessage(`${visionErrors[meta.error] || "Request failed"}. The original image and confirmed content were preserved.`);
      } else {
        setVisionReview(mapVisionEnvelope(result.vision));
        if (stage === "recognition") {
          setImageText(result.recognition?.text || ""); setConfirmedText(null);
          setTextWarnings(result.recognition?.warnings || []);
        }
        setVisionMessage(`${meta?.status === "no_text" ? "No text was recognized; manual entry is available. " : ""}Model ${meta?.model} · ${meta?.duration_ms} ms · ${meta?.usage?.total_tokens ?? "unknown"} tokens`);
      }
      const refreshed = await request(`/memories/${memory.id}`);
      setSelected((current) => current?.id === memory.id ? refreshed : current);
      await load();
    } catch (error) { setVisionMessage(`${visionRequestError(error)} No automatic retry was made; the original image and content were preserved.`); }
    finally { visionLock.current = false; setVisionBusy(false); }
  };
  const confirmVision = (stage: "recognition" | "analysis") => {
    if (visionLock.current) return;
    Alert.alert(stage === "recognition" ? "Send this image to OpenAI?" : "Send confirmed text to OpenAI?", stage === "recognition" ? "The image may contain personal information and this request may incur a cost. You must review the result." : "Only your confirmed text is sent—never the image or device location. Review the analysis before saving.", [{ text: "Cancel", style: "cancel" }, { text: "Agree and Continue", onPress: () => runVision(stage) }]);
  };

  const acceptVision = async () => {
    if (!selected || !visionReview || visionLock.current) return;
    visionLock.current = true; setVisionBusy(true);
    try {
      const value = await request(`/memories/${selected.id}/image/vision/accept`, { method: "POST", body: JSON.stringify({ ...visionReview, title: captureTitle.trim() }) });
      setSelected(value); setVisionReview(null); setAiDraft(null); setShowImageDraft(false); setVisionMessage("Confirmed and saved. The original text and image were preserved."); await load();
    } catch (error) { setVisionMessage(`Save failed: ${visionRequestError(error)}`); }
    finally { visionLock.current = false; setVisionBusy(false); }
  };
  const rejectVision = async () => {
    if (!selected || visionLock.current) return;
    visionLock.current = true; setVisionBusy(true);
    try { await request(`/memories/${selected.id}/image/vision`, { method: "DELETE" }); const refreshed = await request(`/memories/${selected.id}`); setSelected(refreshed); setVisionReview(null); setVisionMessage("Draft rejected. Existing content was preserved."); await load(); }
    catch (error) { setVisionMessage(`Unable to reject draft: ${visionRequestError(error)}`); }
    finally { visionLock.current = false; setVisionBusy(false); }
  };

  const generateAI = async () => { if (!selected) return; setAiLoading(true); setAiDraft(null); try { setAiDraft(await request(`/memories/${selected.id}/assist`, { method: "POST", body: JSON.stringify({ operations: ["summary", "classification", "tags"] }) })); } catch (e) { Alert.alert("AI draft failed", "AI is unavailable. You can still edit and save manually.\n" + String(e)); } finally { setAiLoading(false); } };
  const acceptAI = async () => { if (!selected || !aiDraft?.draft) return; try { const value = await request(`/memories/${selected.id}`, { method: "PATCH", body: JSON.stringify({ confirmed_content: aiDraft.draft.summary, category: aiDraft.draft.category.value, tags: aiDraft.draft.tags.map((tag) => tag.value), confirmation_status: "accepted" }) }); setSelected(value); setAiDraft(null); await load(); } catch (e) { Alert.alert("Unable to accept draft", String(e)); } };
  const rejectAI = async () => { if (!selected) return; try { const value = await request(`/memories/${selected.id}`, { method: "PATCH", body: JSON.stringify({ confirmation_status: "rejected" }) }); setSelected(value); setAiDraft(null); } catch (e) { Alert.alert("Unable to reject draft", String(e)); } };
  const persistNotificationMap = async (next: typeof notificationMap) => { setNotificationMap(next); await AsyncStorage.setItem("memory-reminder-notifications", JSON.stringify(next)); };
  const clearNotificationMetadata = async (memoryId: number) => { const next = { ...notificationMap }; delete next[String(memoryId)]; await persistNotificationMap(next); };
  const showPersistedReminder = (memory: Memory) => {
    const current = memory.reminder_at ? new Date(memory.reminder_at) : null;
    setSelected(memory);
    setReminderDay(current ? localDay(current) : null);
    setReminderTime(current ? localTime(current) : null);
    setReminderTouched(false);
  };
  const updateMemoryCaches = (memory: Memory) => {
    setMemories((items) => items.map((item) => item.id === memory.id ? memory : item));
    setSearchResults((items) => items?.map((item) => item.id === memory.id ? memory : item) ?? null);
  };
  const setReminder = async () => {
    const reminderDate = reminderDateTime(reminderDay, reminderTime);
    if (!selected || !reminderDay || !reminderTime || !reminderDate) return setReminderError("Choose both a reminder date and time. A time is never added automatically.");
    if (reminderDate <= new Date()) return setReminderError("Choose a future date and time.");
    if (reminderBusy) return;
    setReminderError(null); setReminderMessage(null); setReminderBusy(true);
    const memory = selected;
    const wasUpdate = !!memory.reminder_at;
    const locallyStored = notificationMap[String(memory.id)];
    const previous = locallyStored ?? (memory.reminder_at && memory.reminder_notification_id ? { notification_id: memory.reminder_notification_id, reminder_at: memory.reminder_at } : undefined);
    let newNotificationId: string | null = null;
    try {
      const permission = await Notifications.getPermissionsAsync();
      const granted = permission.granted || (await Notifications.requestPermissionsAsync()).granted;
      if (!granted) { setReminderError("Notification permission was denied. No local notification was created."); return; }
      newNotificationId = await Notifications.scheduleNotificationAsync({ content: { title: memory.title, body: "Memory reminder", data: { memoryId: memory.id }, sound: "default" }, trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: reminderDate, channelId: "memory-reminders" } });
      const scheduled = await Notifications.getAllScheduledNotificationsAsync();
      if (!scheduled.some((item) => item.identifier === newNotificationId)) throw new Error("The new notification was not found in the scheduled notification list.");
      const saved = await request(`/memories/${memory.id}/reminder`, { method: "PUT", body: JSON.stringify({ reminder_at: reminderDate.toISOString(), notification_id: newNotificationId }) });
      const nextMap = { ...notificationMap, [memory.id]: { notification_id: newNotificationId, reminder_at: saved.reminder_at } };
      await persistNotificationMap(nextMap);
      if (previous && previous.notification_id !== newNotificationId) await Notifications.cancelScheduledNotificationAsync(previous.notification_id);
      delete reminderDrafts.current[memory.id];
      const persisted = { ...memory, reminder_at: saved.reminder_at, reminder_notification_id: saved.notification_id };
      showPersistedReminder(persisted);
      updateMemoryCaches(persisted);
      const successMessage = wasUpdate ? "Reminder updated" : "Reminder set";
      setReminderMessage(successMessage);
    } catch (error) {
      console.error("notification scheduling or persistence failed", error);
      if (newNotificationId) { try { await Notifications.cancelScheduledNotificationAsync(newNotificationId); } catch (rollbackError) { console.error("notification rollback failed", rollbackError); } }
      try {
        if (memory.reminder_at) {
          await request(`/memories/${memory.id}/reminder`, { method: "PUT", body: JSON.stringify({ reminder_at: memory.reminder_at, notification_id: previous?.notification_id ?? memory.reminder_notification_id ?? null }) });
        } else {
          await request(`/memories/${memory.id}/reminder`, { method: "DELETE" });
        }
      } catch (rollbackError) { console.error("backend reminder rollback failed", rollbackError); }
      try {
        const restoredMap = { ...notificationMap };
        if (previous) restoredMap[String(memory.id)] = previous; else delete restoredMap[String(memory.id)];
        await persistNotificationMap(restoredMap);
      } catch (storageError) { console.error("notification metadata rollback failed", storageError); }
      try { const refreshed = await request(`/memories/${memory.id}`); showPersistedReminder(refreshed); updateMemoryCaches(refreshed); } catch (refreshError) { console.error("reminder refresh failed", refreshError); showPersistedReminder(memory); }
      setReminderError(`Reminder update failed. The previously saved reminder is still shown: ${String(error)}`);
    } finally { setReminderBusy(false); }
  };
  const cancelReminder = async () => { if (!selected) return; const previous = notificationMap[String(selected.id)] ?? (selected.reminder_at && selected.reminder_notification_id ? { notification_id: selected.reminder_notification_id, reminder_at: selected.reminder_at } : undefined); try { if (previous) await Notifications.cancelScheduledNotificationAsync(previous.notification_id); await request(`/memories/${selected.id}/reminder`, { method: "DELETE" }); await clearNotificationMetadata(selected.id); delete reminderDrafts.current[selected.id]; setReminderDay(null); setReminderTime(null); setReminderTouched(false); setSelected({ ...selected, reminder_at: null, reminder_notification_id: null }); setReminderError(null); setReminderMessage(null); } catch (error) { console.error("reminder cancellation failed", error); setReminderError("Unable to cancel the reminder. Please try again."); } };
  if (screen === "ask") return <SafeAreaView edges={["top", "right", "bottom", "left"]} style={styles.container}><ScrollView contentContainerStyle={styles.scrollContent}>
    <Text style={styles.title}>Ask My Memories</Text>
    <Button title="Back to List" onPress={() => setScreen("list")} disabled={questionBusy} />
    <Text style={styles.supportingText}>Ask about your saved content. Answers include sources you can open.</Text>
    <TextInput style={[styles.input, styles.multiline]} placeholder="What upcoming activities are related to sports?" value={question} maxLength={1000} editable={!questionBusy} onChangeText={setQuestion} multiline />
    <View style={styles.askButton}><Button title={questionBusy ? "Finding an answer…" : "Ask"} onPress={askMemories} disabled={questionBusy || !question.trim()} variant="primary" /></View>
    {questionError && <Text style={styles.error}>{questionError}</Text>}
    {answer && <View style={styles.contentCard}><MarkdownText value={answer.answer} />
      {answer.sources.map((source) => <Button key={source.memory_id} title={`[Memory ${source.memory_id}] ${source.title}${source.event_date ? ` · ${source.event_date}` : ""}`} onPress={async () => {
        try { openDetail(await request(`/memories/${source.memory_id}`)); }
        catch { setQuestionError("This source is no longer available."); }
      }} />)}
    </View>}
  </ScrollView></SafeAreaView>;
  if (screen === "capture" && selected) return <SafeAreaView edges={["top", "right", "bottom", "left"]} style={styles.container}><ScrollView>
    <Text style={styles.title}>Review Image Memory</Text>
    <Text style={styles.status}>The image and recognized content are preserved. Final content changes only after confirmation.</Text>
    <Text style={styles.aiLabel}>Title</Text><TextInput style={styles.input} value={captureTitle} onChangeText={(title) => { setCaptureTitle(title); titleTouched.current = true; }} editable={!captureBusy} maxLength={200} />
    {selected.source_image_path && <><Button title={showSavedImage ? "Hide Image" : "Preview Image"} onPress={() => setShowSavedImage(!showSavedImage)} />
      {showSavedImage && <Image style={styles.sourceImage} source={{ uri: `${API_URL}/memories/${selected.id}/image/file` }} resizeMode="contain" />}</>}
    <Button title="Reanalyse with OpenAI" onPress={confirmReanalyzeImage} disabled={captureBusy} />
    {visionReview ? <View style={styles.aiCard}><Text style={styles.aiTitle}>Analysis Draft · Review Required</Text>
      <VisionFields key={visionReview.draft_id} value={visionReview.draft} onChange={reviewVisionFields} disabled={captureBusy} />
    </View> : <><Text style={styles.aiLabel}>Content (enter manually if recognition failed)</Text>
      <TextInput style={[styles.input, styles.multiline]} multiline maxLength={12000} value={manualContent} onChangeText={setManualContent} editable={!captureBusy} placeholder="Enter the content to save" /></>}
    {reminderDay && <Text style={styles.status}>Suggested reminder: {reminderDay}{reminderTime ? ` · ${reminderTime}` : " · no specific time"}. You can edit and set it after saving.</Text>}
    {(captureBusy || ocrBusy) && <ActivityIndicator />}{captureError && <Text style={styles.error}>{captureError}</Text>}{imageError && <Text style={styles.error}>{imageError}</Text>}
    <Button title="Confirm and Save" onPress={finalizeCapture} disabled={captureBusy || ocrBusy || !captureTitle.trim()} />
    <Button title="Save Draft for Later" onPress={() => setScreen("list")} disabled={captureBusy} />
  </ScrollView></SafeAreaView>;
  if (screen === "form" && selected?.source_image_path) return <SafeAreaView edges={["top", "right", "bottom", "left"]} style={styles.container}><ScrollView>
    <Text style={styles.title}>Edit{editVision?.category ? ` · ${editVision.category}` : " Image Memory"}</Text>
    <Text style={styles.aiLabel}>Title</Text><TextInput style={styles.input} value={draft.title} onChangeText={(title) => setDraft({ ...draft, title })} />
    {editVision && <View style={styles.aiCard}><Text style={styles.aiTitle}>Confirmed Analysis Fields</Text><VisionFields value={editVision} onChange={editVisionFields} preferred={categoryFields(editVision.category)} /></View>}
    <View style={styles.reminderCard}><Text style={styles.aiTitle}>One-time Reminder</Text>
      <Button title="Choose Date" onPress={() => { setPickerValue(reminderDateTime(reminderDay, reminderTime) || (reminderDay ? new Date(`${reminderDay}T12:00:00`) : new Date(Date.now() + 86400000))); setPickerMode("date"); }} />
      <Button title="Choose Time" onPress={() => { setPickerValue(reminderDateTime(reminderDay, reminderTime) || (reminderDay ? new Date(`${reminderDay}T12:00:00`) : new Date())); setPickerMode("time"); }} />
      {pickerMode && <><DateTimePicker key={pickerMode} value={pickerValue} mode={pickerMode} display="spinner" onChange={(event, value) => { if (event.type !== "dismissed" && value) setPickerValue(value); }} onDismiss={() => setPickerMode(null)} /><Button title="Done" onPress={() => { const day = pickerMode === "date" ? localDay(pickerValue) : reminderDay; const time = pickerMode === "time" ? localTime(pickerValue) : reminderTime; setReminderDay(day); setReminderTime(time); reminderDrafts.current[selected.id] = { day, time }; setReminderTouched(true); setPickerMode(null); }} /></>}
      {reminderDay && <Text style={styles.selectedTime}>Reminder date ({selected.reminder_at ? "set" : "not saved"}): {reminderDay}</Text>}
      {reminderTime && <Text style={styles.selectedTime}>Time: {reminderTime}</Text>}
      {reminderDay && !reminderTime && <Text style={styles.warning}>Choose a specific time before setting the reminder.</Text>}
      <Button title={reminderBusy ? "Saving Reminder…" : reminderMessage === "Reminder updated" ? "Reminder updated" : selected.reminder_at ? "Update Reminder" : "Set Reminder"} onPress={setReminder} disabled={reminderBusy} />
      {selected.reminder_at && <Button title="Cancel Reminder" color="#b00020" onPress={cancelReminder} />}
      {reminderError && <Text style={styles.error}>{reminderError}</Text>}
    </View>
    <Button title="Save Changes" onPress={save} /><Button title="Cancel" onPress={() => setScreen("detail")} />
  </ScrollView></SafeAreaView>;
  if (screen === "form") return <Form draft={draft} setDraft={setDraft} onSave={save} onCancel={() => setScreen(selected ? "detail" : "list")} editing={!!selected} />;
  if (screen === "detail" && selected) return <SafeAreaView edges={["top", "right", "bottom", "left"]} style={styles.container}><ScrollView contentContainerStyle={styles.scrollContent}><Text style={styles.eyebrow}>MEMORY DETAILS</Text><Text style={styles.title}>{selected.title} <Text style={styles.titleDate}>· {memoryDate(selected.created_at)}</Text></Text><Text style={styles.meta}>{selected.category || "Uncategorised"}</Text><TagChips tags={selected.tags} /><View style={styles.imageButtonRow}><View style={styles.actionItem}><Button title="Edit" onPress={openEdit} disabled={visionBusy} /></View><View style={styles.actionItem}><Button title="Back to List" onPress={() => setScreen("list")} disabled={visionBusy} /></View></View><View style={styles.contentCard}><Text style={styles.sectionTitle}>Memory Content</Text><MarkdownText value={selected.confirmed_content} /></View><View style={styles.imageCard}><View style={styles.imageButtonRow}><View style={styles.actionItem}><Button title={imageLoading ? "Processing…" : "Add or Replace Image"} onPress={chooseImage} disabled={imageLoading || visionBusy} nowrap /></View>{selected.source_image_path && <View style={styles.actionItem}><Button title={showSavedImage ? "Hide Image" : "Preview Image"} onPress={() => setShowSavedImage(!showSavedImage)} nowrap /></View>}</View>{selected.source_image_filename && <Text style={styles.supportingText}>Attached: {selected.source_image_filename}</Text>}{selected.source_image_path && <Button title="Reanalyse with OpenAI" onPress={confirmReanalyzeImage} disabled={captureBusy || imageLoading} />}{showSavedImage && selected.source_image_path && <Image style={styles.sourceImage} source={{ uri: `${API_URL}/memories/${selected.id}/image/file` }} resizeMode="contain" />}
{visionReview && <View style={styles.aiCard}><Text style={styles.aiTitle}>Analysis Draft · Review Required</Text>
  <Text style={styles.aiLabel}>Title</Text><TextInput style={styles.input} value={captureTitle} onChangeText={(title) => { setCaptureTitle(title); titleTouched.current = true; }} maxLength={200} />
  <VisionFields key={visionReview.draft_id} value={visionReview.draft} onChange={reviewVisionFields} disabled={captureBusy} />
  <Button title="Confirm and Save Analysis" onPress={acceptVision} disabled={captureBusy} />
  <Button title="Reject Draft" onPress={rejectVision} disabled={captureBusy} /></View>}
{captureError && <Text style={styles.error}>{captureError}</Text>}
{visionMessage && <Text style={styles.warning}>{visionMessage}</Text>}
{imageError && <Text style={styles.error}>{imageError}</Text>}
{selected.confirmed_vision && <View><Text style={styles.aiTitle}>Confirmed Memory Fields</Text><VisionFields value={JSON.parse(selected.confirmed_vision)} disabled /></View>}
</View><View style={styles.reminderCard}><Text style={styles.aiTitle}>Reminder</Text>
<Button title="Choose Date" onPress={() => { setPickerValue(reminderDateTime(reminderDay, reminderTime) || (reminderDay ? new Date(`${reminderDay}T12:00:00`) : new Date(Date.now() + 86400000))); setPickerMode("date"); }} />
<Button title="Choose Time" onPress={() => { setPickerValue(reminderDateTime(reminderDay, reminderTime) || (reminderDay ? new Date(`${reminderDay}T12:00:00`) : new Date())); setPickerMode("time"); }} />
{pickerMode && <><DateTimePicker key={pickerMode} value={pickerValue} mode={pickerMode} display="spinner" onChange={(event, value) => { if (event.type !== "dismissed" && value) setPickerValue(value); }} onDismiss={() => setPickerMode(null)} /><Button title="Done" onPress={() => { const day = pickerMode === "date" ? localDay(pickerValue) : reminderDay; const time = pickerMode === "time" ? localTime(pickerValue) : reminderTime; setReminderDay(day); setReminderTime(time); reminderDrafts.current[selected.id] = { day, time }; setReminderTouched(true); setPickerMode(null); }} /></>}
{reminderDay && <Text style={styles.selectedTime}>Reminder date ({selected.reminder_at ? "set" : "not saved"}): {reminderDay}</Text>}
{reminderTime && <Text style={styles.selectedTime}>Time: {reminderTime}</Text>}
{reminderDay && !reminderTime && <Text style={styles.warning}>Choose a specific time before setting the reminder.</Text>}
<Button title={reminderBusy ? "Saving Reminder…" : reminderMessage === "Reminder updated" ? "Reminder updated" : selected.reminder_at ? "Update Reminder" : "Set Reminder"} onPress={setReminder} disabled={reminderBusy} />
{selected.reminder_at && <Button title="Cancel Reminder" color="#b00020" onPress={cancelReminder} />}
{reminderError && <Text style={styles.error}>{reminderError}</Text>}</View>{!selected.source_image_path && <><Button title={aiLoading ? "Generating…" : "Generate AI Draft"} onPress={generateAI} disabled={aiLoading} />{aiDraft?.draft && <View style={styles.aiCard}><Text style={styles.aiTitle}>AI Draft · Confirmation Required</Text><Text style={styles.aiLabel}>Summary</Text>{reviewEditing ? <TextInput style={[styles.input, styles.multiline]} multiline value={aiDraft.draft.summary} onChangeText={(summary) => setAiDraft({ ...aiDraft, draft: { ...aiDraft.draft!, summary } })} /> : <MarkdownText value={aiDraft.draft.summary} /> }<Text style={styles.aiLabel}>Category: {aiDraft.draft.category.value} · Confidence {Math.round(aiDraft.draft.category.confidence * 100)}% · {aiDraft.draft.category.uncertain ? "uncertain" : "likely"}</Text><Text style={styles.aiLabel}>Tags: {aiDraft.draft.tags.map((tag) => tag.value).join(", ")}</Text>{aiDraft.warnings.map((warning) => <Text key={warning} style={styles.warning}>Note: {warning}</Text>)}<Button title="Accept AI Draft" onPress={acceptAI} /><Button title="Edit Draft Content" onPress={() => setReviewEditing(true)} /><Button title="Reject AI Draft" color="#b00020" onPress={rejectAI} /></View>}</>}<Button title="Delete Memory" color="#b00020" onPress={remove} disabled={visionBusy} /></ScrollView></SafeAreaView>;
  const tagChoices = availableTags(memories);
  const displayedMemories = filterByTags(searchResults ?? memories, selectedTags);
  const toggleTag = (tag: string) => setSelectedTags((tags) => tags.includes(tag) ? tags.filter((item) => item !== tag) : [...tags, tag]);
  const clearFilters = async () => { setSelectedTags([]); await clearSearch(); };
  return <SafeAreaView edges={["top", "right", "bottom", "left"]} style={styles.container}><Text style={styles.eyebrow}>LOCAL LIBRARY</Text><Text style={styles.title}>My Memories</Text><View style={styles.actionPanel}><View style={styles.topActionRow}><View style={styles.actionItem}><Button title="+ New Memory" onPress={openCreate} variant="primary" /></View><View style={styles.actionItem}><Button title="+ Take Photo" onPress={() => chooseNewImage("camera")} variant="primary" disabled={captureBusy} /></View><View style={styles.actionItem}><Button title="+ Choose Photo" onPress={() => chooseNewImage("library")} variant="primary" disabled={captureBusy} /></View></View></View><View style={styles.searchPanel}><View style={styles.searchRow}><TextInput style={styles.searchInput} placeholder="Search title, content, or tags" placeholderTextColor="#78828c" value={searchKeyword} onChangeText={(value) => { setSearchKeyword(value); if (!value.trim()) setSearchResults(null); setSearchError(null); }} onSubmitEditing={search} returnKeyType="search" /><Button title="Search" onPress={search} /></View>{searchResults !== null && <Button title="Clear Search" onPress={clearSearch} />}
<Button title="Ask My Memories" onPress={() => setScreen("ask")} />
<View style={styles.tagFilter}><Button title={showTagChoices ? "Hide Tags" : `Filter by Tags${selectedTags.length ? ` (${selectedTags.length})` : ""}`} onPress={() => setShowTagChoices(!showTagChoices)} />
{selectedTags.length > 0 && <View style={styles.tagRow}>{selectedTags.map((tag) => <TouchableOpacity key={tag} style={styles.selectedTag} onPress={() => toggleTag(tag)}><Text style={styles.selectedTagText} numberOfLines={1}>✕ {tag}</Text></TouchableOpacity>)}<Button title="Clear All" onPress={() => setSelectedTags([])} /></View>}
{showTagChoices && (tagChoices.length ? <View style={styles.tagRow}>{tagChoices.map((tag) => <TouchableOpacity key={tag} style={selectedTags.includes(tag) ? styles.selectedTag : styles.tagChoice} onPress={() => toggleTag(tag)}><Text style={selectedTags.includes(tag) ? styles.selectedTagText : styles.tagText} numberOfLines={1}>{selectedTags.includes(tag) ? "✓ " : ""}{tag}</Text></TouchableOpacity>)}</View> : <Text style={styles.status}>No tags yet. Add tags to a Memory to filter by them.</Text>)}</View></View>
{(loading || searchLoading) && <View style={styles.loadingState}><ActivityIndicator color="#27634a" /><Text style={styles.status}>{searchLoading ? "Searching…" : "Loading…"}</Text></View>}
{(loadError || searchError) && <View style={styles.errorCard}><Text style={styles.error}>{loadError || searchError}</Text><Button title="Try Again" onPress={searchError ? search : load} /></View>}
{!loading && !loadError && <Text style={styles.resultCount}>{(searchResults !== null || selectedTags.length > 0) ? (displayedMemories.length ? `${displayedMemories.length} ${displayedMemories.length === 1 ? "result" : "results"}` : "No Memories match your search and tags") : (memories.length ? `${memories.length} ${memories.length === 1 ? "Memory" : "Memories"}` : "No Memories yet")}</Text>}
{!loading && !loadError && !displayedMemories.length ? <View style={styles.emptyState}><Text style={styles.emptyTitle}>{searchResults !== null || selectedTags.length > 0 ? "No Matches" : "Create Your First Memory"}</Text><Text style={styles.supportingText}>{searchResults !== null || selectedTags.length > 0 ? "Try another search or clear the filters." : "Create one manually, take a photo, or choose one from your library."}</Text>{(searchResults !== null || selectedTags.length > 0) && <Button title="Clear All Filters" onPress={clearFilters} />}</View> : <FlatList data={displayedMemories} contentContainerStyle={styles.listContent} keyExtractor={(item) => String(item.id)} renderItem={({ item }) => <TouchableOpacity style={styles.card} onPress={() => openDetail(item)} activeOpacity={0.72}><View style={styles.cardHeader}><Text style={styles.cardTitle} numberOfLines={2}>{item.title} <Text style={styles.cardDate}>· {memoryDate(item.created_at)}</Text></Text>{item.confirmation_status === "draft" && <Text style={styles.draftBadge}>Draft</Text>}</View>{item.category && <Text style={styles.cardMeta}>{item.category}</Text>}<Text style={styles.cardContent} numberOfLines={2}>{item.confirmed_content || (item.source_image_path ? "Image draft — open to continue reviewing" : item.original_text)}</Text><TagChips tags={item.tags} compact /></TouchableOpacity>} refreshing={loading} onRefresh={load} />}</SafeAreaView>;
}

export default function App() {
  return <SafeAreaProvider><AppContent /></SafeAreaProvider>;
}

const visionLabels: Record<VisionFieldKey, string> = { summary: "Summary", category: "Category", tags: "Tags", amount: "Amount", currency: "Currency (ISO, e.g. NZD)", date: "Date (YYYY-MM-DD)", time: "Time (HH:MM)", due_date: "Due Date (YYYY-MM-DD)", institution: "Organisation", location_name: "Location Name", location_address: "Address", location_purpose: "Location Purpose" };

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
    {visible.length === 0 && <Text style={styles.status}>No useful fields were extracted. Add fields below.</Text>}
    {visible.map((key) => <View key={key}>
      <View style={styles.fieldRow}><Text style={styles.aiLabel}>{visionLabels[key]}{value.uncertain_fields.includes(key) ? " · Uncertain" : ""}</Text>{!disabled && <Button title="Remove" onPress={() => removeField(key)} />}</View>
      {disabled ? <Text style={styles.fieldValue}>{key === "tags" ? value.tags.join(", ") : value[key]}</Text> : <TextInput style={[styles.input, key === "summary" && styles.multiline]} editable={!!onChange} value={key === "tags" ? value.tags.join(", ") : value[key] || ""} onChangeText={(text) => change(key, text)} multiline={key === "summary"} placeholder="Enter a value" />}
    </View>)}
    {!disabled && available.length > 0 && <><Button title={adding ? "Hide Field Options" : "Add Field ▾"} onPress={() => setAdding(!adding)} />{adding && available.map((key) => <Button key={key} title={visionLabels[key]} onPress={() => { setRemoved((fields) => fields.filter((field) => field !== key)); setVisible((fields) => [...fields, key]); setAdding(false); }} />)}</>}
    {value.warnings.map((warning, index) => <Text key={index} style={styles.warning}>Note: {warning}</Text>)}
  </View>;
}

function Form({ draft, setDraft, onSave, onCancel, editing }: { draft: Draft; setDraft: (draft: Draft) => void; onSave: () => void; onCancel: () => void; editing: boolean }) {
  const field = (key: keyof Draft, label: string, placeholder: string, multiline = false) => <View><Text style={styles.fieldLabel}>{label}</Text><TextInput style={[styles.input, multiline && styles.multiline]} placeholder={placeholder} placeholderTextColor="#78828c" value={draft[key]} onChangeText={(value) => setDraft({ ...draft, [key]: value })} multiline={multiline} /></View>;
  const formTags = draft.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
  return <SafeAreaView edges={["top", "right", "bottom", "left"]} style={styles.container}><ScrollView contentContainerStyle={styles.scrollContent}><Text style={styles.eyebrow}>{editing ? "UPDATE MEMORY" : "ADD TO LIBRARY"}</Text><Text style={styles.title}>{editing ? "Edit Memory" : "New Memory"}</Text><View style={styles.formCard}>{field("title", "Title", "Enter a clear, recognisable title")}{field("original_text", "Content", "Record the important details from this document", true)}{field("category", "Category", "For example: bill, receipt, notice")}{field("tags", "Tags", "Separate multiple tags with commas")}<TagChips tags={formTags} /></View><View style={styles.formActions}><Button title="Save" onPress={onSave} /><Button title="Cancel" onPress={onCancel} /></View></ScrollView></SafeAreaView>;
}

const markdownStyles = {
  body: { color: "#27322d", fontSize: 16, lineHeight: 25 },
  heading1: { color: "#27634a", fontSize: 22, fontWeight: "700" as const, marginTop: 8, marginBottom: 8 },
  heading2: { color: "#27634a", fontSize: 19, fontWeight: "700" as const, marginTop: 8, marginBottom: 6 },
  strong: { fontWeight: "700" as const, color: "#17201c" },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  code_inline: { backgroundColor: "#edf2ef", color: "#315f49" },
  fence: { backgroundColor: "#edf2ef", borderRadius: 8, padding: 10 },
  link: { color: "#2f7656" },
};

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 18, paddingTop: 16, backgroundColor: "#f5f7f6" },
  scrollContent: { paddingBottom: 32 },
  eyebrow: { color: "#27634a", fontSize: 12, fontWeight: "700", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 4 },
  title: { color: "#17201c", fontSize: 29, lineHeight: 37, fontWeight: "700", marginBottom: 14 },
  titleDate: { color: "#65716b", fontSize: 15, fontWeight: "600" },
  sectionTitle: { color: "#27634a", fontSize: 13, fontWeight: "800", letterSpacing: 0.7, textTransform: "uppercase", marginBottom: 10 },
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
  button: { minHeight: 44, justifyContent: "center", alignItems: "center", backgroundColor: "#ffffff", borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, marginVertical: 3, borderWidth: 1, borderColor: "#c4d5cc" },
  singleLineButton: { width: "100%", paddingHorizontal: 6 },
  buttonText: { color: "#315f49", fontSize: 14, lineHeight: 19, fontWeight: "700", textAlign: "center" },
  primaryButton: { backgroundColor: "#dcece4", borderColor: "#a9cbb9", shadowColor: "#315f49", shadowOpacity: 0.08, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 1 , alignSelf: "flex-start",flexShrink: 0},
  primaryButtonText: { color: "#234d39", fontSize: 12 },
  compactButton: { alignSelf: "center", minWidth: 176, paddingHorizontal: 22 },
  destructiveButton: { backgroundColor: "#fff4f4", borderColor: "#c7434f" },
  destructiveButtonText: { color: "#a3202d" },
  disabledButton: { backgroundColor: "#dfe5e2", borderColor: "#d2d9d5", opacity: 0.72 },
  disabledButtonText: { color: "#77827c" },
  actionPanel: { alignItems: "stretch", gap: 10, marginBottom: 12, paddingVertical: 2 },
  actionRow: { flexDirection: "row", gap: 8 },
  topActionRow: { flexDirection: "row", alignItems: "stretch", gap: 8 },
  actionItem: { flex: 1, flexBasis: 0, minWidth: 0 },
  headerActions: { flexDirection: "row", alignSelf: "center", width: "82%", gap: 10, marginTop: 2, marginBottom: 8 },
  loadingState: { alignItems: "center", paddingVertical: 18 },
  status: { color: "#65716b", lineHeight: 20, marginVertical: 8 },
  resultCount: { color: "#65716b", fontSize: 13, fontWeight: "600", marginVertical: 8 },
  error: { color: "#9f2430", lineHeight: 20 },
  success: { color: "#245b3f", lineHeight: 20, fontWeight: "700" },
  errorCard: { backgroundColor: "#fff1f2", borderColor: "#f0c4c9", borderWidth: 1, borderRadius: 12, padding: 12, gap: 8, marginVertical: 8 },
  emptyState: { backgroundColor: "#ffffff", alignItems: "center", borderRadius: 16, borderWidth: 1, borderColor: "#e1e6e3", padding: 24, gap: 8 },
  emptyTitle: { color: "#26332d", fontSize: 18, fontWeight: "700" },
  supportingText: { color: "#65716b", lineHeight: 20 },
  listContent: { paddingBottom: 28 },
  card: { padding: 16, backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#e1e6e3", borderRadius: 16, marginBottom: 10, shadowColor: "#18231e", shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 2 },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  cardTitle: { color: "#17201c", flex: 1, fontSize: 18, lineHeight: 23, fontWeight: "700" },
  cardDate: { color: "#718078", fontSize: 12, fontWeight: "600" },
  cardMeta: { color: "#527060", fontSize: 13, fontWeight: "600", marginTop: 5 },
  cardContent: { color: "#4d5953", fontSize: 15, lineHeight: 22, marginTop: 8 },
  draftBadge: { color: "#7a5200", backgroundColor: "#fff2ce", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 12, fontWeight: "700" },
  meta: { color: "#65716b", marginBottom: 10 },
  contentCard: { backgroundColor: "#ffffff", borderRadius: 16, padding: 16, marginVertical: 12, borderWidth: 1, borderColor: "#e1e6e3" },
  content: { color: "#27322d", fontSize: 16, lineHeight: 25, marginBottom: 10 },
  selectedTime: { fontSize: 15, color: "#245b3f", marginVertical: 5 },
  imageCard: { borderWidth: 1, borderColor: "#c9ded3", backgroundColor: "#f9fcfa", borderRadius: 16, padding: 15, marginVertical: 12, gap: 9 },
  imageActions: { gap: 8 },
  imageButtonRow: { flexDirection: "row", alignItems: "stretch", gap: 10 },
  reminderCard: { borderWidth: 1, borderColor: "#c8d9e7", backgroundColor: "#f8fbfd", borderRadius: 16, padding: 15, marginVertical: 12, gap: 9 },
  sourceImage: { width: "100%", height: 260, marginVertical: 10, borderRadius: 12, backgroundColor: "#edf0ee" },
  aiCard: { borderWidth: 1, borderColor: "#ead49c", backgroundColor: "#fffcf4", borderRadius: 16, padding: 15, marginVertical: 12, gap: 9 },
  aiTitle: { color: "#26332d", fontSize: 18, fontWeight: "700" },
  aiLabel: { color: "#27634a", fontSize: 13, fontWeight: "800", letterSpacing: 0.35, marginBottom: 6 },
  fieldValue: { color: "#26322c", fontSize: 16, lineHeight: 24, backgroundColor: "#ffffff", borderRadius: 10, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: "#e1e6e3" },
  fieldLabel: { color: "#35413b", fontSize: 14, fontWeight: "700", marginBottom: 6 },
  fieldRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  warning: { color: "#805800", backgroundColor: "#fff7df", padding: 9, borderRadius: 8, marginBottom: 8 },
  input: { color: "#17201c", backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#cbd3cf", borderRadius: 10, padding: 12, fontSize: 16, marginBottom: 14 },
  multiline: { minHeight: 140, textAlignVertical: "top" },
  formCard: { backgroundColor: "#ffffff", borderRadius: 16, padding: 16, borderWidth: 1, borderColor: "#e1e6e3" },
  formActions: { gap: 8, marginTop: 14 },
  askButton: { width: "100%", marginTop: 4 },
});
