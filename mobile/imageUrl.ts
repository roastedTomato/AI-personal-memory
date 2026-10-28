export function memoryImageUrl(apiUrl: string, memoryId: number, sourcePath: string, variant: "original" | "thumbnail" | "preview" = "original", retry = 0): string {
  const version = sourcePath.split("/").pop() || sourcePath;
  return `${apiUrl}/memories/${memoryId}/image/file?variant=${variant}&v=${encodeURIComponent(version)}${retry ? `&retry=${retry}` : ""}`;
}
