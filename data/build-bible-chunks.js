// Turns the raw Douay-Rheims JSON into a flat list of citation-labeled
// chunks, one per verse: { id, citation, text }.
// Cleanup: strip the '*' cross-reference markers (not part of the verse
// text), and fix the '`' character used in place of an apostrophe.

const fs = require('fs');
const bible = require('./bible-raw.json');

function clean(text) {
  return text.replace(/\*/g, '').replace(/`/g, "'").trim();
}

const chunks = [];
for (const book of Object.keys(bible)) {
  for (const chapter of Object.keys(bible[book])) {
    for (const verse of Object.keys(bible[book][chapter])) {
      const text = clean(bible[book][chapter][verse]);
      if (!text) continue;
      chunks.push({
        id: `bible:${book}:${chapter}:${verse}`,
        source: 'bible',
        citation: `${book} ${chapter}:${verse}`,
        text,
      });
    }
  }
}

fs.writeFileSync('bible-chunks.json', JSON.stringify(chunks));
console.log('Wrote', chunks.length, 'Bible chunks');
