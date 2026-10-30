// Channels John publishes by hand (Substack, the website). They are reviewed and approved like any platform, but they
// are never put on Zernio: no calendar item is made for them, no slot is picked, no post is sent. This list is a floor
// under the calendar's own `manual` setting, so a calendar file without `manual_channels` can never send a newsletter.
export const HAND_PUBLISHED = ["newsletter", "website"] as const;

export const isHandPublished = (channel: string): boolean => (HAND_PUBLISHED as readonly string[]).includes(channel);

/** True when every channel is published by hand: approving it has nothing to schedule. */
export const allHandPublished = (channels: string[]): boolean => channels.length > 0 && channels.every(isHandPublished);
