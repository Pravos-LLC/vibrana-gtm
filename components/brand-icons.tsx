// Platform marks for the review screens. Plain SVG: lucide has no brand icons.
// `mono` draws the simple-icons glyph in currentColor (analytics screens: identity, not a data color).
import { SocialMark } from "@/components/guide/social-mark";

type Props = { className?: string; title?: string; mono?: boolean };

export function LinkedInIcon({ className = "size-5", title = "LinkedIn", mono }: Props) {
  if (mono) return <SocialMark channel="linkedin" mono className={className} />;
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label={title}>
      <rect width="24" height="24" rx="5" fill="#0A66C2" />
      <path fill="#fff" d="M6.1 9.4h2.6V18H6.1zM7.4 5.3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM10.4 9.4h2.5v1.2c.4-.7 1.3-1.4 2.6-1.4 2.7 0 3.2 1.8 3.2 4.1V18h-2.6v-4.2c0-1 0-2.3-1.4-2.3s-1.6 1.1-1.6 2.2V18h-2.7z" />
    </svg>
  );
}

export function InstagramIcon({ className = "size-5", title = "Instagram", mono }: Props) {
  if (mono) return <SocialMark channel="instagram" mono className={className} />;
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id="ig-grad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#FEDA75" />
          <stop offset="0.35" stopColor="#FA7E1E" />
          <stop offset="0.6" stopColor="#D62976" />
          <stop offset="0.85" stopColor="#962FBF" />
          <stop offset="1" stopColor="#4F5BD5" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6" fill="url(#ig-grad)" />
      <rect x="5.5" y="5.5" width="13" height="13" rx="3.6" fill="none" stroke="#fff" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3.1" fill="none" stroke="#fff" strokeWidth="1.6" />
      <circle cx="16.1" cy="7.9" r="0.95" fill="#fff" />
    </svg>
  );
}

export function YouTubeIcon({ className = "size-5", title = "YouTube", mono }: Props) {
  if (mono) return <SocialMark channel="youtube" mono className={className} />;
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label={title}>
      <rect x="1" y="4.5" width="22" height="15" rx="4.5" fill="#FF0000" />
      <path fill="#fff" d="M10 8.9v6.2l5.3-3.1z" />
    </svg>
  );
}

/** Substack's bookmark mark. Not in PLATFORM: the newsletter is published by hand, never a Zernio platform. */
export function SubstackIcon({ className = "size-5", title = "Substack" }: Props) {
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label={title}>
      <rect width="24" height="24" rx="5" fill="#FF6719" />
      <path fill="#fff" d="M6.5 6h11v1.6h-11zM6.5 9h11v1.6h-11zM6.5 12h11v6.5l-5.5-3.1-5.5 3.1z" />
    </svg>
  );
}

export const PLATFORM = {
  linkedin: { label: "LinkedIn", Icon: LinkedInIcon },
  instagram: { label: "Instagram", Icon: InstagramIcon },
  youtube: { label: "YouTube", Icon: YouTubeIcon },
} as const;
