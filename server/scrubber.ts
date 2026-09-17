/**
 * Em-dash and AI fingerprint scrubber.
 * Removes patterns commonly associated with AI-generated content
 * before any outreach email is sent.
 */

export interface ScrubResult {
  text: string;
  replacements: number;
}

const REPLACEMENTS: Array<[RegExp, string]> = [
  // Em-dash and en-dash variants -> comma + space (most natural in mid-sentence)
  [/\s*[—–]\s*/g, ", "],
  // Smart double quotes -> straight
  [/[\u201C\u201D]/g, '"'],
  // Smart single quotes -> straight
  [/[\u2018\u2019]/g, "'"],
  // Ellipsis character -> three dots
  [/\u2026/g, "..."],
  // Non-breaking space -> regular space
  [/\u00A0/g, " "],
  // Multiple spaces -> single space
  [/  +/g, " "],
];

// L4 fix (2026-07): Connectors like "Moreover," and "Furthermore," are only
// AI fingerprints when used as sentence openers. Stripping them anywhere in
// the text can break legitimate mid-sentence usage and leave odd grammar.
// The sentence-start anchor (^|(?<=[.!?]\s+)) restricts removal to openers.
const FINGERPRINT_PHRASES: RegExp[] = [
  /\bIn (today's|the modern) (fast-paced|ever-changing|rapidly evolving) (world|landscape|environment)\b[^.]*\./gi,
  /\bIt's (important|crucial|essential) to note that\b[^.]*\./gi,
  /\bAt the end of the day\b[^.]*,?/gi,
  // Only strip at sentence start (beginning of string or after sentence-ending punctuation)
  /(^|(?<=[.!?]\s+))In conclusion,?\s*/gim,
  /(^|(?<=[.!?]\s+))Moreover,?\s*/gim,
  /(^|(?<=[.!?]\s+))Furthermore,?\s*/gim,
];

export function scrubText(input: string): ScrubResult {
  let text = input;
  let replacements = 0;

  for (const [pattern, replacement] of REPLACEMENTS) {
    text = text.replace(pattern, (match) => {
      replacements += 1;
      return replacement;
    });
  }

  for (const phrase of FINGERPRINT_PHRASES) {
    text = text.replace(phrase, () => {
      replacements += 1;
      return "";
    });
  }

  // Trim leading/trailing whitespace per line
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");

  return { text, replacements };
}

export function scrubEmail(input: { subject: string; body: string }): {
  subject: string;
  body: string;
  totalReplacements: number;
} {
  const subjectResult = scrubText(input.subject);
  const bodyResult = scrubText(input.body);
  return {
    subject: subjectResult.text.trim(),
    body: bodyResult.text,
    totalReplacements: subjectResult.replacements + bodyResult.replacements,
  };
}
