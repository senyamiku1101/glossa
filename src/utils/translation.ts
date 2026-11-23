/**
 * Split a translation source into complete, bounded pieces without dropping text.
 * Keeps typical multi-paragraph selections in one combined prompt (up to 3500 chars)
 * instead of repeating instructions per paragraph; when splitting is required,
 * prefers paragraph breaks before sentence boundaries.
 */
export function splitTranslationSource(
  source: string,
  maxChars = 3500,
): string[] {
  const pieces: string[] = [];
  let rest = source.trim();
  const limit = Math.max(100, maxChars);
  while (rest.length > limit) {
    const min = Math.floor(limit * 0.55);
    let split = -1;
    // Prefer a blank-line paragraph break so paragraphs stay intact.
    for (let i = limit; i >= min; i--) {
      if (rest[i - 1] === "\n" && rest[i - 2] === "\n") {
        split = i;
        break;
      }
    }
    if (split < 0) {
      for (let i = limit; i >= min; i--) {
        if (
          (/[。！？；]/.test(rest[i - 1]) &&
            !/[”’」』）》\]）】]/.test(rest[i])) ||
          /[。！？；][”’」』）》\]）】]/.test(rest.slice(i - 2, i)) ||
          (/\s/.test(rest[i]) && /[.!?;]/.test(rest[i - 1]))
        ) {
          split = i;
          break;
        }
      }
    }
    if (split < 0) {
      for (let i = limit; i >= min; i--) {
        if (/\s/.test(rest[i])) {
          split = i;
          break;
        }
      }
    }
    if (split < 0) split = limit;
    pieces.push(rest.slice(0, split).trim());
    rest = rest.slice(split).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}
