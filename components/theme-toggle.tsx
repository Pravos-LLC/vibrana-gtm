'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useSidebarOptional } from '@/components/ui/sidebar';

const THEME_COOKIE = 'vibrana-theme';

function saveTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const domain = location.hostname === 'brand.example.com' || location.hostname.endsWith('.brand.example.com') ? '; Domain=.brand.example.com' : '';
  document.cookie = `${THEME_COOKIE}=${theme}${domain}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
}

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const sidebar = useSidebarOptional();
  const showLabel = sidebar ? sidebar.open || sidebar.mobileOpen : true;

  useEffect(() => {
    const value = document.cookie.split('; ').find((item) => item.startsWith(`${THEME_COOKIE}=`))?.split('=')[1];
    const theme = value === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    setDark(theme === 'dark');
  }, []);

  function toggle() {
    const next = dark ? 'light' : 'dark';
    saveTheme(next);
    setDark(next === 'dark');
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={dark}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-line px-2 text-ink-2 transition-colors hover:bg-surface-overlay hover:text-ink"
    >
      {dark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
      {showLabel && <span className="text-xs font-medium">{dark ? 'Light mode' : 'Dark mode'}</span>}
    </button>
  );
}
