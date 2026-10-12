/** Split a translation source into complete, bounded pieces without dropping text. */
export function splitTranslationSource(
  source: string,
  maxChars = 1000,
): string[] {
  const pieces: string[] = [];
  let rest = source.trim();
  const limit = Math.max(100, maxChars);
  while (rest.length > limit) {
    const min = Math.floor(limit * 0.55);
    let split = -1;
    for (let i = limit; i >= min; i--) {
      if (/\s/.test(rest[i]) && /[.!?;。！？；]/.test(rest[i - 1])) {
        split = i;
        break;
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
