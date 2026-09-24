import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOT_FOUND_TEXT,
  answerFromHandbook,
  buildPrompt,
  citedIds,
  retrievePolicyContext
} from '../src/services/chat.js';

const settings = { maxContextChunks: 6, minRelevanceScore: 0.3, handbookOnly: true };

function match(score, text, page = 1) {
  return { score, metadata: { docId: 'hr', source: 'HR.pdf', page, text } };
}

test('retrievePolicyContext drops low-scoring chunks and numbers the rest', async () => {
  const deps = {
    embedText: async () => [1, 2, 3],
    queryVectors: async (vector, topK) => {
      assert.equal(topK, 6);
      return [match(0.8, 'Leave is 20 days', 4), match(0.31, 'Carry over 5 days', 5), match(0.1, 'Parking')];
    }
  };

  const context = await retrievePolicyContext('leave?', deps, settings);
  assert.deepEqual(
    context.map((c) => [c.id, c.page, c.source]),
    [
      [1, 4, 'HR.pdf'],
      [2, 5, 'HR.pdf']
    ]
  );
});

test('answerFromHandbook refuses without calling the model when nothing relevant is found', async () => {
  let generated = false;
  const result = await answerFromHandbook(
    { message: 'What is the parking policy?' },
    {
      retrieve: async () => [],
      generate: async () => {
        generated = true;
        return 'made up';
      }
    },
    settings
  );

  assert.equal(generated, false);
  assert.deepEqual(result, { text: NOT_FOUND_TEXT, citations: [] });
});

test('answerFromHandbook still asks the model with no context when policy-only mode is off', async () => {
  let prompt = '';
  const result = await answerFromHandbook(
    { message: 'How do I write a good email?' },
    {
      retrieve: async () => [],
      generate: async (p) => {
        prompt = p;
        return 'General guidance: keep it short.';
      }
    },
    { ...settings, handbookOnly: false }
  );

  assert.match(prompt, /general guidance, not company policy/);
  assert.equal(result.text, 'General guidance: keep it short.');
});

test('answerFromHandbook only returns the citations the answer uses', async () => {
  const context = [
    { id: 1, source: 'HR.pdf', page: 4, score: 0.8, text: 'Leave is 20 days' },
    { id: 2, source: 'HR.pdf', page: 9, score: 0.5, text: 'Sick leave is 10 days' },
    { id: 3, source: 'IT.pdf', page: 2, score: 0.4, text: 'Laptops are refreshed every 3 years' }
  ];

  const result = await answerFromHandbook(
    { message: 'How much leave do I get?' },
    { retrieve: async () => context, generate: async () => 'You get 20 days [1] plus 10 sick days [1, 2].' },
    settings
  );

  assert.deepEqual(
    result.citations.map((c) => c.id),
    [1, 2]
  );
});

test('citedIds reads single and grouped markers', () => {
  assert.deepEqual([...citedIds('a [1] b [2,3] c [3]')], [1, 2, 3]);
  assert.deepEqual([...citedIds('no markers')], []);
});

test('buildPrompt includes numbered sources and recent history', () => {
  const prompt = buildPrompt({
    message: 'And sick leave?',
    context: [{ id: 1, source: 'HR.pdf', page: 9, text: 'Sick leave is 10 days' }],
    history: [{ role: 'user', text: 'How much leave?' }],
    handbookOnly: true
  });

  assert.match(prompt, /\[1\] source="HR.pdf" page=9\nSick leave is 10 days/);
  assert.match(prompt, /USER: How much leave\?/);
  assert.match(prompt, new RegExp(NOT_FOUND_TEXT.replace(/[.?]/g, '\\$&')));
});
