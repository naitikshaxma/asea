import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'asea-theme'; // also read by the inline script in index.html

interface ThemeContextValue {
  preference: ThemePreference;
  resolved: 'light' | 'dark';
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

const systemDark = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [prefersDark, setPrefersDark] = useState(systemDark);
  const resolved = preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference;

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const onChange = () => setPrefersDark(media.matches);
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage unavailable (private mode); the choice lasts for this tab
    }
  }, []);

  return <ThemeContext.Provider value={{ preference, resolved, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
