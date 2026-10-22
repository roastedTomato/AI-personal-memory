import React from "react";
import { MemoryForm } from "../components/MemoryForm";

export function MemoryEditScreen(props: React.ComponentProps<typeof MemoryForm>) {
  return <MemoryForm {...props} />;
}
