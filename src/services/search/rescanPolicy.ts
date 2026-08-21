/**
 * Telling a correction apart from a question.
 *
 * "Are you sure?" is not a description of a moment. Searched literally it can
 * only fail — no video contains a scene matching the words "are you sure" —
 * and the failure looks exactly like the app ignoring the user. What the
 * sentence actually means is: your last answer was wrong, look again.
 *
 * This is the thing a person does without thinking, and the reason the product
 * needs it explicitly: the model is asked one question at a time and never
 * sees the conversation, so nothing else in the system can notice that a
 * correction is not a new subject.
 */

const RETRY_PATTERNS = [
  /\blook\s+(again|harder|closer|more carefully)\b/i,
  /\b(try|check|search|scan)\s+again\b/i,
  /\bare\s+you\s+(sure|certain)\b/i,
  /\b(it'?s|it is|its|there'?s|there is)\s+(definitely|clearly|obviously)\s+there\b/i,
  /\bkeep\s+looking\b/i,
  /\b(re-?scan|re-?search|re-?check)\b/i,
  /\bthat(?:'?s| is)\s+(wrong|not right)\b/i,
  /\byou\s+missed\s+(it|one|them)\b/i,
  /\bwatch\s+(it|the video)\s+again\b/i,
  /\bgo\s+back\s+and\s+(look|check|watch)\b/i,
];

/**
 * A short aside is a correction; a long sentence is an instruction.
 *
 * "Check again around the part where they open the boot" describes where to
 * look and should be searched as written. The cutoff is what keeps a real
 * instruction that happens to contain "check again" from being swallowed and
 * replaced by the previous question.
 */
const MAX_CORRECTION_WORDS = 12;

export function isCorrection(instruction: string): boolean {
  const trimmed = instruction.trim();
  if (!trimmed) return false;
  if (trimmed.split(/\s+/).length > MAX_CORRECTION_WORDS) return false;
  return RETRY_PATTERNS.some((pattern) => pattern.test(trimmed));
}
