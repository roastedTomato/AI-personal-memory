import React, { useEffect, useState } from "react";
import { Image, type ImageProps, type ImageSourcePropType } from "react-native";
import { authorizationHeaders } from "../api/auth";
import { readMemoryImage } from "../api/images";

// Original bytes bypass Lambda. Thumbnails/previews keep authenticated API URLs.
export function MemoryImage(props: ImageProps) {
  const cloud = process.env.EXPO_PUBLIC_APP_ENV === "cloud";
  const source = props.source;
  const uri = source && typeof source === "object" && "uri" in source ? source.uri : undefined;
  const [resolved, setResolved] = useState<ImageSourcePropType | undefined>(cloud ? undefined : source);
  useEffect(() => {
    let active = true;
    if (!cloud || !uri) { setResolved(source); return; }
    setResolved(undefined);
    const original = uri.match(/\/memories\/(\d+)\/image\/file(?:\?|$)/);
    const variant = uri.match(/[?&]variant=([^&]+)/)?.[1];
    (async () => {
      const value = original && (!variant || variant === "original")
        ? { uri: await readMemoryImage(Number(original[1])) }
        : { uri, headers: await authorizationHeaders() };
      if (active) setResolved(value);
    })().catch(() => { if (active) setResolved(undefined); });
    return () => { active = false; };
  }, [cloud, uri]);
  return <Image {...props} source={resolved} />;
}
