import { useState, useEffect, useCallback } from 'react';

/**
 * Like useState, but persists the value to localStorage under `key`.
 * Falls back to `fallback` if nothing is stored or parsing fails.
 */
export function usePersistedState<T>(
  key: string,
  fallback: T | (() => T),
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) return JSON.parse(stored) as T;
    } catch {}
    return typeof fallback === 'function' ? (fallback as () => T)() : fallback;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value]);

  return [value, setValue];
}

/**
 * Persisted Set<string> backed by localStorage.
 * Stored as a JSON array; read back as a Set.
 */
export function usePersistedSet(
  key: string,
  fallback: Set<string> | (() => Set<string>),
): [Set<string>, (updater: (prev: Set<string>) => Set<string>) => void] {
  const [value, setValue] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored) return new Set(JSON.parse(stored) as string[]);
    } catch {}
    return typeof fallback === 'function' ? fallback() : fallback;
  });

  const update = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => {
      setValue((prev) => {
        const next = updater(prev);
        try {
          localStorage.setItem(key, JSON.stringify([...next]));
        } catch {}
        return next;
      });
    },
    [key],
  );

  return [value, update];
}
