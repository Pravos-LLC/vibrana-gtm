"use client";
import { useEffect, useState } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { VibranaLogo } from "@/components/brand";
import { PASSWORD_MIN } from "@/lib/reviewer/access";

// The page behind the emailed reset link. The browser client exchanges the link's code for a session on load (the code
// verifier sits in this browser, so the link must be opened where the reset was asked for); then the person sets a password.
export default function Reset() {
  const [ready, setReady] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Built in the browser only (an effect or a handler), never while the page prerenders.
  const client = () => createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
  useEffect(() => {
    // getSession waits for the code exchange the client starts on load.
    createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!)
      .auth.getSession()
      .then(({ data }) => setReady(!!data.session));
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password"));
    if (password.length < PASSWORD_MIN) return setError(`Use at least ${PASSWORD_MIN} characters.`);
    if (password !== String(form.get("confirm"))) return setError("The two passwords differ.");
    setBusy(true);
    const { error } = await client().auth.updateUser({ password });
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
            <CardTitle className="text-pl-xl">Set a password</CardTitle>
            <CardDescription>{ready === false ? "This link has expired or was opened in a different browser." : `At least ${PASSWORD_MIN} characters.`}</CardDescription>
          </CardHeader>
          <CardContent>
            {ready === false ? (
              <Button asChild className="w-full">
                <a href="/login">Back to sign in</a>
              </Button>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="password">New password</Label>
                  <Input id="password" name="password" type="password" autoComplete="new-password" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="confirm">Confirm password</Label>
                  <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
                </div>
                {error && <p className="text-sm text-red-strong">{error}</p>}
                <Button type="submit" className="w-full" disabled={busy || ready === null}>
                  {busy ? "Saving" : "Save password"}
                  {!busy && <ArrowRight />}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
