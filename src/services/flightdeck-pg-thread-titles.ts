export const FLIGHTDECK_THREAD_TITLE_MAX_LENGTH = 120;
export const FLIGHTDECK_THREAD_TITLE_FALLBACK = 'Untitled thread';

// Flight Deck stores both @-prefixed mentions and non-prefixed record pills.
// Remove the complete semantic token so neither its markup nor visible label
// contributes words to an automatically derived title. Labels may contain
// escaped Markdown characters such as `\[` and `\]`.
const completeMentionPattern = /@?\[(?:\\.|[^\]\\])*\]\(mention:[a-zA-Z_][a-zA-Z0-9_-]*:[^)]+\)/g;
const markdownImagePattern = /!\[((?:\\.|[^\]\\])*)\]\([^)]*\)/g;
const markdownLinkPattern = /\[((?:\\.|[^\]\\])*)\]\([^)]*\)/g;
const htmlTagPattern = /<[^>]*>/g;
const markdownDecorationPattern = /(^|\s)(?:#{1,6}|>|[-+*])\s+|[*_~`]+/g;

function unescapeMarkdownLabel(value: string): string {
  return value.replace(/\\([\\`*_[\]{}()#+.!~>-])/g, '$1');
}

export function normalizeFlightDeckPgThreadTitle(
  value: unknown,
  { omitMentionLabels = false }: { omitMentionLabels?: boolean } = {},
): string {
  return String(value ?? '')
    .replace(completeMentionPattern, (token) => {
      if (omitMentionLabels) return ' ';
      const labelEnd = token.indexOf('](mention:');
      const labelStart = token.startsWith('@[') ? 2 : 1;
      return labelEnd > labelStart ? ` ${unescapeMarkdownLabel(token.slice(labelStart, labelEnd))} ` : ' ';
    })
    .replace(markdownImagePattern, (_match, label: string) => ` ${unescapeMarkdownLabel(label)} `)
    .replace(markdownLinkPattern, (_match, label: string) => ` ${unescapeMarkdownLabel(label)} `)
    .replace(htmlTagPattern, ' ')
    .replace(markdownDecorationPattern, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function deriveFlightDeckPgThreadTitle(messageBody: unknown): string {
  const visibleText = normalizeFlightDeckPgThreadTitle(messageBody, { omitMentionLabels: true });
  if (!visibleText) return FLIGHTDECK_THREAD_TITLE_FALLBACK;
  const firstTenWords = visibleText.split(' ').slice(0, 10).join(' ');
  return firstTenWords.slice(0, FLIGHTDECK_THREAD_TITLE_MAX_LENGTH).trim() || FLIGHTDECK_THREAD_TITLE_FALLBACK;
}

export function validateFlightDeckPgThreadTitle(value: unknown): { title: string; error: string | null } {
  const title = normalizeFlightDeckPgThreadTitle(value);
  if (!title) return { title, error: 'title must be a non-empty string' };
  if (title.length > FLIGHTDECK_THREAD_TITLE_MAX_LENGTH) {
    return { title, error: `title must be at most ${FLIGHTDECK_THREAD_TITLE_MAX_LENGTH} characters` };
  }
  return { title, error: null };
}

export function effectiveFlightDeckPgThreadTitle(storedTitle: unknown, sourceMessageBody: unknown): string {
  const title = normalizeFlightDeckPgThreadTitle(storedTitle);
  if (title && !title.includes('mention:') && !title.includes('@[')) return title;
  return deriveFlightDeckPgThreadTitle(sourceMessageBody);
}
