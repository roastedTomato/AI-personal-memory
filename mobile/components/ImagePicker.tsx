import React from "react";
import { Button, Image, View } from "react-native";

export function ImagePicker({ uri, onPick }: { uri?: string | null; onPick: () => void }) {
  return <View>{<Button title={uri ? "Replace Image" : "Add Image"} onPress={onPick} />}{uri && <Image source={{ uri }} resizeMode="contain" style={{ width: "100%", height: 220 }} />}</View>;
}
