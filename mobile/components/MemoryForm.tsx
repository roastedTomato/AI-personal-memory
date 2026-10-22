import React from "react";
import { Text, TextInput, View } from "react-native";

export function MemoryForm({ title, content, category, tags, onChange }: { title: string; content: string; category: string; tags: string; onChange: (field: "title" | "content" | "category" | "tags", value: string) => void }) {
  const field = (label: string, value: string, key: "title" | "content" | "category" | "tags", multiline = false) => <View><Text style={{ color: "#27634a", fontWeight: "700", marginBottom: 6 }}>{label}</Text><TextInput value={value} onChangeText={(text) => onChange(key, text)} multiline={multiline} style={{ borderWidth: 1, borderColor: "#cbd3cf", borderRadius: 10, padding: 12, marginBottom: 14, minHeight: multiline ? 120 : undefined }} /></View>;
  return <View>{field("Title", title, "title")}{field("Content", content, "content", true)}{field("Category", category, "category")}{field("Tags", tags, "tags")}</View>;
}
