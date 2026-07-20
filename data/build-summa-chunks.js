// Turns the four raw Summa Theologica text files (Project Gutenberg plain
// text) into a flat list of citation-labeled chunks, one per article:
// { id, citation, title, text }.
//
// Cleanup: strip the Gutenberg header/footer boilerplate, strip the
// underscore-divider lines between articles, and un-mark the underscore
// italics (e.g. "_I answer that,_" -> "I answer that,").

const fs = require('fs');

const PARTS = [
  { file: 'summa-1.txt', part: 'I' },
  { file: 'summa-1-2.txt', part: 'I-II' },
  { file: 'summa-2-2.txt', part: 'II-II' },
  { file: 'summa-3.txt', part: 'III' },
];

const START_RE = /\*{3}\s*START OF (THIS |THE )?PROJECT GUTENBERG EBOOK[^\n]*\n/i;
const END_RE = /\*{3}\s*END OF (THIS |THE )?PROJECT GUTENBERG EBOOK[^\n]*\n/i;
const ARTICLE_HEADER_RE = /^[A-Z]+ ARTICLE \[([^\]]+)\]$/gm;

function stripGutenbergWrapper(raw) {
  const startMatch = START_RE.exec(raw);
  const endMatch = END_RE.exec(raw);
  const start = startMatch ? startMatch.index + startMatch[0].length : 0;
  const end = endMatch ? endMatch.index : raw.length;
  return raw.slice(start, end);
}

function cleanBody(text) {
  return text
    .replace(/^_{5,}\s*$/gm, '') // divider lines
    .replace(/_([^_\n]+)_/g, '$1') // italics markers
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// "[I, Q. 1, Art. 1]" -> { part: "I", question: "1", article: "1" }
// Tolerant of the source's occasional transcription slips: "." vs ","
// between segments, missing periods after "Q"/"Art", lowercase "art", and
// an occasionally-missing part prefix (falls back to the file's part).
function parseBracket(bracket, fallbackPart) {
  const m = /^(?:([IVX]+(?:-[IVX]+)?)\s*[.,]\s*)?Q[.,]*\s*(\d+)\s*[.,]?\s*(?:[Aa]rt|A)[.,]?\s*(\d+)$/.exec(bracket.trim());
  if (!m) return null;
  return { part: m[1] || fallbackPart, question: m[2], article: m[3] };
}

const allChunks = [];

for (const { file, part: filePart } of PARTS) {
  const raw = fs.readFileSync(file, 'utf8');
  const body = stripGutenbergWrapper(raw);

  const headers = [...body.matchAll(ARTICLE_HEADER_RE)];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const bracket = parseBracket(header[1], filePart);
    if (!bracket) {
      console.warn('Could not parse bracket:', header[1]);
      continue;
    }
    const contentStart = header.index + header[0].length;
    const contentEnd = i + 1 < headers.length ? headers[i + 1].index : body.length;
    const rawArticle = body.slice(contentStart, contentEnd);

    const lines = rawArticle.split('\n').map(l => l.trim()).filter(Boolean);
    const title = lines[0] || '';
    const articleText = cleanBody(rawArticle);

    allChunks.push({
      id: `summa:${bracket.part}:${bracket.question}:${bracket.article}`,
      source: 'summa',
      citation: `Summa, Part ${bracket.part}, Q${bracket.question}, Art. ${bracket.article}`,
      title,
      text: articleText,
    });
  }
}

fs.writeFileSync('summa-chunks.json', JSON.stringify(allChunks));
console.log('Wrote', allChunks.length, 'Summa chunks');
