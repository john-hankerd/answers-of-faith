// netlify/functions/ask.js
// The "brain" of Answers of Faith. Takes a question, searches the Bible +
// Summa library for the best-matching passages, and hands those passages
// to Claude with a strict instruction to answer using ONLY what's given —
// never the model's own general knowledge — and to footnote every claim.
//
// The Anthropic API key lives only here, server-side. It is never sent to
// the browser.

const https = require('https');
const { search } = require('./lib/search.js');

const SEARCH_RESULTS = 12;

const SYSTEM_PROMPT = `You answer questions about the Catholic faith for a study-helper web app called Answers of Faith.

Rules that must never break:
1. Answer using ONLY the passages provided below. Never use your own general knowledge about Catholicism, theology, history, or anything else — only what is in the provided passages.
2. Write in plain English, at about a 7th-grade reading level. Calm and reverent tone.
3. Every factual claim in your answer must be footnoted to the specific passage it came from, using [1], [2], etc.
4. Only include a source in your sources list if you actually cited it with a footnote number in the answer body.
5. If the passages provided do not actually answer the question, set found to false and write an honest, brief note saying these sources don't cover it — do not guess, and do not pad out an answer from passages that don't really address the question.
6. This app is a study helper, not a priest, and its answers are not official Church teaching. Do not claim otherwise.

You will be given a numbered list of passages (each with its citation). Use the passage numbers as your footnote numbers.`;

function callClaude(question, passages) {
  const passageList = passages
    .map((p, i) => `[${i + 1}] ${p.citation}\n${p.text}`)
    .join('\n\n---\n\n');

  const userMessage = `Question: ${question}\n\nPassages:\n\n${passageList}`;

  const body = JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
    tools: [
      {
        name: 'provide_answer',
        description: 'Provide the grounded answer to the question, or a not-found response.',
        input_schema: {
          type: 'object',
          properties: {
            found: {
              type: 'boolean',
              description: 'true if the provided passages contain enough to actually answer the question',
            },
            paragraphs: {
              type: 'array',
              items: { type: 'string' },
              description: 'The answer body, split into 1-3 short paragraphs. Each factual claim ends with a bracketed footnote number like [1] matching the passage number used. Omit if found is false.',
            },
            notFoundMessage: {
              type: 'string',
              description: 'Only used when found is false: a short, honest note that these sources do not cover the question.',
            },
          },
          required: ['found'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'provide_answer' },
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Claude cites using the passages' original 1-N list positions (whatever
// is easiest for it to reference). The front-end needs sequential
// footnotes starting at 1 for only the sources actually used, in the order
// they first appear — so remap based on the real [N] markers in the
// returned text, rather than trusting a separately-reported list (which
// could drift out of sync with what the model actually wrote).
function remapCitations(paragraphs, passages) {
  const fullText = paragraphs.join(' ');
  const seenOrder = [];
  const seenSet = new Set();
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(fullText))) {
    const n = parseInt(m[1], 10);
    if (!seenSet.has(n)) {
      seenSet.add(n);
      seenOrder.push(n);
    }
  }

  const oldToNew = new Map(seenOrder.map((oldNum, idx) => [oldNum, idx + 1]));

  const remappedParagraphs = paragraphs.map((p) =>
    p.replace(/\[(\d+)\]/g, (full, numStr) => {
      const newNum = oldToNew.get(parseInt(numStr, 10));
      return newNum ? `[${newNum}]` : '';
    })
  );

  const sources = seenOrder
    .map((oldNum) => passages[oldNum - 1])
    .filter(Boolean)
    .map((p) => ({ citation: p.citation, quote: p.text }));

  return { paragraphs: remappedParagraphs, sources };
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const question = (payload.question || '').trim();
  if (!question) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Missing question' }) };
  }
  if (question.length > 500) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Question is too long' }) };
  }

  const passages = search(question, SEARCH_RESULTS);
  if (passages.length === 0) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: false, notFoundMessage: "I couldn't find teaching on this in these sources." }),
    };
  }

  try {
    const result = await callClaude(question, passages);
    if (result.status !== 200) {
      console.error('Claude API error:', JSON.stringify(result.body).slice(0, 500));
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'The answer service is unavailable right now.' }) };
    }

    const toolUse = (result.body.content || []).find((c) => c.type === 'tool_use');
    if (!toolUse) {
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'Unexpected response from the answer service.' }) };
    }

    const answer = toolUse.input;

    if (!answer.found) {
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          found: false,
          notFoundMessage: answer.notFoundMessage || "I couldn't find teaching on this in these sources.",
        }),
      };
    }

    const { paragraphs, sources } = remapCitations(answer.paragraphs || [], passages);

    if (sources.length === 0) {
      // The model said found=true but didn't actually cite anything —
      // treat that as a not-found rather than showing an unfootnoted claim.
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ found: false, notFoundMessage: "I couldn't find teaching on this in these sources." }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: true, asked: question, paragraphs, sources }),
    };
  } catch (err) {
    console.error('ask.js error:', err.message);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
