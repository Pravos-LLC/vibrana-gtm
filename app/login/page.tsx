"use client";
import { useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { VibranaLogo } from "@/components/brand";

export default function Login() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const supabase = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
    if (forgot) {
      // Supabase answers the same whether or not the address has an account, so this never reveals who does.
      const { error } = await supabase.auth.resetPasswordForEmail(String(form.get("email")), { redirectTo: `${window.location.origin}/auth/reset` });
      setBusy(false);
      if (error) setError(error.message);
      else setSent(true);
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email: String(form.get("email")), password: String(form.get("password")) });
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    window.location.href = "/";
  }
  return (
    <main className="grid min-h-screen place-items-center px-6">
      <div className="fixed right-6 top-6 z-10">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <VibranaLogo size={72} wordmark={false} />
          <p className="mt-4 font-display text-sm font-semibold tracking-[0.05em] text-ink">VIBRANA</p>
        </div>
        <Card glow={false}>
          <CardHeader>
            <CardTitle className="text-pl-xl">Vibrana GTM</CardTitle>
            <CardDescription>Content, pipeline and spend, in one view.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" autoComplete="username" required />
              </div>
              {!forgot && (
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input id="password" name="password" type="password" autoComplete="current-password" required />
                </div>
              )}
              {error && <p className="text-sm text-red-strong">{error}</p>}
              {sent && <p className="text-sm text-ink">If that address has an account, a reset link is on its way. Open it in this browser.</p>}
              <Button type="submit" className="w-full" disabled={busy}>
                {forgot ? (busy ? "Sending" : "Send reset link") : busy ? "Signing in" : "Sign in"}
                {!busy && <ArrowRight />}
              </Button>
              <button
                type="button"
                className="w-full text-center text-sm text-ink-3 underline-offset-4 hover:underline"
                onClick={() => {
                  setForgot(!forgot);
                  setError(null);
                  setSent(false);
                }}
              >
                {forgot ? "Back to sign in" : "Forgot password?"}
              </button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
