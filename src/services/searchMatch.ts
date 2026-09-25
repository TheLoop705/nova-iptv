// Forgiving title matching for typed *and dictated* queries.
// Dictation spells things differently from playlists ("n tv" vs "n-tv", "channel four" vs
// "Channel 4", "canal plus" vs "Canal+"), so both sides are folded to the same shape.

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', null: '0', eins: '1', zwei: '2', drei: '3', vier: '4', fünf: '5', funf: '5',
  sechs: '6', sieben: '7', acht: '8', neun: '9', zehn: '10',
};

function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
}

const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** Query → alphanumeric words; spelled-out numbers may match as the word or the digit. */
export function queryWords(q: string): string[][] {
  const raw = fold(q).split(/[^a-z0-9]+/).filter(Boolean);
  const out: string[][] = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    const unit = Number(NUMBER_WORDS[raw[i + 1]]);
    // "twenty four" → 24
    if (TENS[w] && unit >= 1 && unit <= 9) {
      out.push([w + raw[i + 1], String(TENS[w] + unit)]);
      i++;
    } else if (TENS[w]) out.push([w, String(TENS[w])]);
    else out.push(NUMBER_WORDS[w] ? [w, NUMBER_WORDS[w]] : [w]);
  }
  return out;
}

/** Title → one compact alphanumeric string that query words are looked up in. */
export function compactTitle(title: string): string {
  return fold(title).replace(/[^a-z0-9]+/g, '');
}

/**
 * 0 = no match; higher is better. Every query word must appear in the title;
 * titles that start with the query rank above ones that merely contain it.
 */
export function matchScore(words: string[][], compact: string): number {
  if (!words.length) return 0;
  const used: string[] = [];
  for (const alts of words) {
    const hit = alts.find((w) => compact.includes(w));
    if (!hit) return 0;
    used.push(hit);
  }
  const joined = used.join('');
  if (compact === joined) return 3;
  if (compact.startsWith(joined)) return 2;
  return 1;
}
