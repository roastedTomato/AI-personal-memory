import React from "react";
import { FlatList } from "react-native";
import { MemoryCard } from "../components/MemoryCard";

export function MemoryListScreen({ memories, onSelect, refreshing, onRefresh }: { memories: any[]; onSelect: (memory: any) => void; refreshing?: boolean; onRefresh?: () => void }) {
  return <FlatList data={memories} keyExtractor={(item) => String(item.id)} renderItem={({ item }) => <MemoryCard memory={item} onPress={() => onSelect(item)} />} refreshing={refreshing} onRefresh={onRefresh} />;
}
