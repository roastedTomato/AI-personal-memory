import { useCallback, useState } from "react";
import { listMemories, searchMemories } from "../api/memories";

export function useMemories<T = any>() {
  const [memories, setMemories] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => { setLoading(true); try { setMemories(await listMemories() as T[]); } finally { setLoading(false); } }, []);
  const search = useCallback(async (keyword: string) => { setLoading(true); try { return await searchMemories(keyword) as T[]; } finally { setLoading(false); } }, []);
  return { memories, setMemories, loading, load, search };
}
