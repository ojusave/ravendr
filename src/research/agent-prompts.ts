/**
 * Preambles prepended to the user's topic before hitting You.com's
 * Research API. Shape the synthesis for voice playback — no bullets,
 * no headers, conversational tone.
 */

export const VOICE_BRIEFING_PREAMBLE = `Write a 2 to 4 minute spoken briefing for someone listening on audio only.
Rules:
- Open with a specific, surprising fact in the first sentence (no generic setup).
- Short sentences. No bullet lists. No headers. No tables.
- Keep inline citations like [1, 2] — we'll strip them for audio but the
  sources array will still surface on screen.
- Three to five short paragraphs.
- Close with one sentence capturing the takeaway.`;

export const RECENT_SCAN_PREAMBLE = `List only *new* developments from the last 12 months.
If nothing significant is new, reply with a single short sentence saying so.
Keep it under 4 short sentences total. No bullets.`;
