// Why John rejects a candidate. Its own module so the client card can import the list without the server code.
export const REJECT_REASONS = [
  { slug: "angle", label: "Wrong angle" },
  { slug: "voice", label: "Doesn't sound like me" },
  { slug: "facts", label: "Facts or sources are weak" },
  { slug: "timing", label: "Not timely anymore" },
  { slug: "duplicate", label: "Already covered" },
  { slug: "topic", label: "Not our topic" },
  { slug: "other", label: "Other" },
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number]["slug"];
