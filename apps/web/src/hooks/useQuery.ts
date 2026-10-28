import { useCallback, useEffect, useRef, useState } from 'react';

export interface QueryState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  refetch: () => Promise<void>;
}

/**
 * Loads data and reloads it when `key` changes. With `pollMs`, it refetches on
 * that interval while `pollMs(data)` returns a number (return null to stop,
 * e.g. once a run has finished). A null key disables the query.
 */
export function useQuery<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: { pollMs?: (data: T | undefined) => number | null } = {}
): QueryState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(key !== null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const pollRef = useRef(options.pollMs);
  pollRef.current = options.pollMs;
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (key === null) return;
    const mine = ++generation.current;
    try {
      const result = await fetcherRef.current();
      if (mine !== generation.current) return;
      setData(result);
      setError(undefined);
    } catch (err) {
      if (mine !== generation.current) return;
      setError(err);
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    setData(undefined);
    setError(undefined);
    setLoading(key !== null);
    void load();
    return () => {
      generation.current++;
    };
  }, [key, load]);

  useEffect(() => {
    if (key === null || loading) return;
    const delay = pollRef.current?.(data);
    if (delay === null || delay === undefined) return;
    const timer = setTimeout(() => void load(), delay);
    return () => clearTimeout(timer);
  }, [key, data, error, loading, load]);

  const refetch = useCallback(async () => {
    await load();
  }, [load]);

  return { data, error, loading, refetch };
}
