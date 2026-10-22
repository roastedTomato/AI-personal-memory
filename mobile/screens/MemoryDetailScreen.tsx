import React from "react";
import { Text, View } from "react-native";

export function MemoryDetailScreen({ memory }: { memory: { title: string; confirmed_content: string } }) {
  return <View><Text>{memory.title}</Text><Text>{memory.confirmed_content}</Text></View>;
}
