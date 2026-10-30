"use client";

const THEME_BOOT = "try{var t=document.cookie.split('; ').find(function(c){return c.indexOf('vibrana-theme=')===0});if(t&&t.split('=')[1]==='dark'){document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark'}}catch(e){}";

/** Runs in the initial HTML, then hydrates as plain text so React does not warn about a client-rendered script. */
export function ThemeScript() {
  return (
    <script
      type={typeof window === "undefined" ? "text/javascript" : "text/plain"}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: THEME_BOOT }}
    />
  );
}
