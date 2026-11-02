import React, { useEffect, useState } from "react";
import { Image, Text, TouchableOpacity, View, type ImageProps, type ImageSourcePropType } from "react-native";
import { authorizationHeaders } from "../api/auth";
import { readMemoryImage } from "../api/images";

// Original bytes bypass Lambda. Thumbnails/previews keep authenticated API URLs.
export function MemoryImage(props: ImageProps) {
  const cloud = process.env.EXPO_PUBLIC_APP_ENV === "cloud";
  const source = props.source;
  const uri = source && typeof source === "object" && "uri" in source ? source.uri : undefined;
  const [resolved, setResolved] = useState<ImageSourcePropType | undefined>(cloud ? undefined : source);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    if (!cloud || !uri) { setResolved(source); return; }
    setResolved(undefined);
    const original = uri.match(/\/memories\/(\d+)\/image\/file(?:\?|$)/);
    const variant = uri.match(/[?&]variant=([^&]+)/)?.[1];
    (async () => {
      const value = original && (!variant || variant === "original")
        ? { uri: await readMemoryImage(Number(original[1])) }
        : { uri, headers: await authorizationHeaders() };
      if (active) setResolved(value);
    })().catch(() => { if (active) { setResolved(undefined); setFailed(true); } });
    return () => { active = false; };
  }, [cloud, uri, attempt]);
  if (failed) return <View style={[props.style, { alignItems: "center", justifyContent: "center" }]}>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retry loading image" onPress={() => { setFailed(false); setAttempt((value) => value + 1); }}>
      <Text style={{ color: "#9f2430", textAlign: "center" }}>Image unavailable · Retry</Text>
    </TouchableOpacity>
  </View>;
  if (!resolved) return <View style={props.style} />;
  return <Image {...props} source={resolved} onError={(event) => { setFailed(true); props.onError?.(event); }} />;
}
