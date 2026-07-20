// v1 search over the Bible + Summa library: TF-IDF-weighted keyword
// matching. Good enough per the build brief ("a strong keyword search over
// the chunks is an acceptable v1 — we can upgrade the search later without
// changing anything the user sees").
//
// Loaded once per warm function container (module-level state), so the
// index only gets built on a cold start, not on every request.
//
// The chunk libraries are loaded via require(), not fs.readFileSync —
// Netlify's function bundler only follows the require()/import graph to
// decide what to include in the deployed bundle, so a dynamic
// fs.readFileSync path (even to a file sitting right next to this one)
// silently doesn't ship, and fails at runtime with ENOENT.

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with',
  'about', 'as', 'it', 'its', 'this', 'that', 'these', 'those', 'i',
  'you', 'he', 'she', 'we', 'they', 'do', 'does', 'did', 'not', 'no',
  'so', 'if', 'than', 'then', 'there', 'their', 'them', 'his', 'her',
  'my', 'your', 'our', 'me', 'him', 'us', 'from', 'into', 'up', 'out',
  'can', 'could', 'should', 'would', 'will', 'shall', 'may', 'might',
  'have', 'has', 'had', 'am', 'what', 'which', 'when', 'where', 'why',
  'who', 'whom', 'how', 'does', 'doth', 'thee', 'thou', 'thy',
]);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z']+/g) || [])
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function loadChunks() {
  const bible = require('../data/bible-chunks.json');
  const summa = require('../data/summa-chunks.json');
  return [...bible, ...summa];
}

// BM25 — chosen specifically over plain TF-IDF because this library mixes
// very short documents (one Bible verse) with very long ones (a full Summa
// article with objections and replies). Plain summed TF-IDF systematically
// favors long documents just for having more words to accumulate score
// from; BM25's document-length normalization (the `b` term below) corrects
// for that, so a short, precisely-on-topic verse can outrank a long,
// loosely-related article.
const K1 = 1.5;
const B = 0.75;

function buildIndex(chunks) {
  const invIndex = new Map(); // token -> Map(chunkIndex -> termFrequency)
  const docFreq = new Map(); // token -> number of chunks containing it
  const docLength = new Array(chunks.length);
  let totalLength = 0;

  chunks.forEach((chunk, idx) => {
    const tokens = tokenize(`${chunk.title || ''} ${chunk.text}`);
    docLength[idx] = tokens.length;
    totalLength += tokens.length;
    const seen = new Set();
    for (const tok of tokens) {
      if (!invIndex.has(tok)) invIndex.set(tok, new Map());
      const postings = invIndex.get(tok);
      postings.set(idx, (postings.get(idx) || 0) + 1);
      if (!seen.has(tok)) {
        seen.add(tok);
        docFreq.set(tok, (docFreq.get(tok) || 0) + 1);
      }
    }
  });

  const avgDocLength = totalLength / chunks.length;
  return { invIndex, docFreq, docLength, avgDocLength, totalDocs: chunks.length };
}

let cached = null;
function getIndex() {
  if (!cached) {
    const chunks = loadChunks();
    const { invIndex, docFreq, docLength, avgDocLength, totalDocs } = buildIndex(chunks);
    cached = { chunks, invIndex, docFreq, docLength, avgDocLength, totalDocs };
  }
  return cached;
}

// Returns the top N chunks (with a relevance score) for a question.
function search(question, limit = 12) {
  const { chunks, invIndex, docFreq, docLength, avgDocLength, totalDocs } = getIndex();
  const queryTokens = [...new Set(tokenize(question))];
  if (queryTokens.length === 0) return [];

  const scores = new Map(); // chunkIndex -> score
  const coverageCount = new Map(); // chunkIndex -> distinct matching query terms

  for (const tok of queryTokens) {
    const postings = invIndex.get(tok);
    if (!postings) continue;
    const df = docFreq.get(tok) || 1;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));

    for (const [chunkIdx, tf] of postings) {
      const norm = 1 - B + B * (docLength[chunkIdx] / avgDocLength);
      const termScore = idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
      scores.set(chunkIdx, (scores.get(chunkIdx) || 0) + termScore);
      coverageCount.set(chunkIdx, (coverageCount.get(chunkIdx) || 0) + 1);
    }
  }

  // Coverage bonus: matching more distinct query words matters more than
  // scoring high on just one of them — rewards chunks that actually
  // address the whole question.
  const ranked = [...scores.entries()]
    .map(([chunkIdx, score]) => {
      const coverage = coverageCount.get(chunkIdx) / queryTokens.length;
      return { chunkIdx, score: score * (0.5 + 0.5 * coverage) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked.map(({ chunkIdx, score }) => ({ ...chunks[chunkIdx], score }));
}

module.exports = { search, tokenize };
