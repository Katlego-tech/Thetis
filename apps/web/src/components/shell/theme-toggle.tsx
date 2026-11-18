"use client";

import { CaretDown, Desktop, Moon, Sun } from "@phosphor-icons/react";
import { useEffect, useSyncExternalStore } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const themeKey = "thetis-theme";
const themeChange = "thetis-theme-change";
const systemQuery = "(prefers-color-scheme: dark)";
const themes = {
  light: { label: "Light", Icon: Sun },
  dark: { label: "Dark", Icon: Moon },
  system: { label: "System", Icon: Desktop },
};

type Theme = keyof typeof themes;

function getTheme(): Theme {
  const theme = document.documentElement.dataset.theme;
  return theme === "light" || theme === "dark" ? theme : "system";
}

function getServerTheme(): Theme {
  return "system";
}

function subscribe(listener: () => void) {
  window.addEventListener(themeChange, listener);
  return () => window.removeEventListener(themeChange, listener);
}

function applyTheme(theme: Theme, systemDark: boolean) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark" || (theme === "system" && systemDark));
}

function selectTheme(value: string) {
  if (value !== "light" && value !== "dark" && value !== "system") return;
  try {
    localStorage.setItem(themeKey, value);
  } catch {
    // A blocked storage preference still applies to the current page.
  }
  applyTheme(value, matchMedia(systemQuery).matches);
  window.dispatchEvent(new Event(themeChange));
}

function ThemeOptions({ theme }: { theme: Theme }) {
  return (
    <DropdownMenuRadioGroup value={theme} onValueChange={selectTheme} aria-label="Theme">
      {Object.entries(themes).map(([value, { label, Icon }]) => (
        <DropdownMenuRadioItem key={value} value={value}>
          <Icon aria-hidden="true" size={16} weight="regular" />
          {label}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

export function ThemeMenu() {
  const theme = useSyncExternalStore(subscribe, getTheme, getServerTheme);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>Theme</DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <ThemeOptions theme={theme} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getTheme, getServerTheme);
  const { label, Icon } = themes[theme];

  useEffect(() => {
    const system = matchMedia(systemQuery);
    const synchronize = () => applyTheme(getTheme(), system.matches);
    synchronize();
    system.addEventListener("change", synchronize);
    return () => system.removeEventListener("change", synchronize);
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="theme-toggle" aria-label={`Theme: ${label}`}>
        <Icon aria-hidden="true" size={16} weight="regular" />
        {label}
        <CaretDown aria-hidden="true" size={16} weight="regular" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <ThemeOptions theme={theme} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
