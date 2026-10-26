// Ported from ComicBit/bb-plugin-genui (Apache-2.0). See THIRD_PARTY.md.
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/** " Did you mean `x`?" for the closest candidate within edit distance 2, else "". */
export function didYouMean(name: string, candidates: Iterable<string>, render = (candidate: string) => candidate): string {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance && distance < name.length) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best === undefined ? "" : ` Did you mean \`${render(best)}\`?`;
}
