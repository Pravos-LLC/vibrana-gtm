import type { Metadata } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import { ThemeScript } from "@/components/theme-script";
import "./globals.css";

// Prism Light typography (brand.example.com): Bricolage Grotesque display, Hanken Grotesk body, JetBrains Mono.
const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display-family", display: "swap" });
const body = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-body-family", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-family", display: "swap" });

export const metadata: Metadata = {
  title: "Vibrana GTM",
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <head>
        <ThemeScript />
      </head>
      <body className="prism-field min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
