import React from "react";
import { Text, View } from "react-native";
import { displayTags } from "../utils/tags";

export function TagList({ tags }: { tags: string[] }) {
  const values = displayTags(tags);
  if (!values.length) return null;
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 7 }}>{values.map((tag) => <View key={tag} style={{ maxWidth: "100%", borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: "#e7f1ec", borderWidth: 1, borderColor: "#c9ded3" }}><Text numberOfLines={1} ellipsizeMode="tail" style={{ color: "#315c48", fontSize: 13 }}>{tag}</Text></View>)}</View>;
}
