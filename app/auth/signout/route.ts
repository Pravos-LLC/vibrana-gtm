import { NextResponse } from "next/server";
import { sessionDb } from "@/lib/supabase/server";

export async function POST(request: Request) {
  await (await sessionDb()).auth.signOut();
  return NextResponse.redirect(new URL("/login", request.url), 303);
}
