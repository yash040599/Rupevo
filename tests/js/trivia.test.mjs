// Tests for the "Did you know?" content and rotation. Run with:  node --test "tests/js/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { financialYear, istWallClock } from '../../site/assets/js/fy.js';
import {
  MARKET_STORIES, pageSeed, startIndex, taxTrivia, TRIVIA_TAGS, triviaPool,
} from '../../site/assets/js/trivia.js';

const fy = financialYear(istWallClock(new Date('2026-10-02T06:00:00Z')));

test('every item has a tag, a title, a short story and a takeaway', () => {
  for (const item of [...MARKET_STORIES, ...taxTrivia(fy)]) {
    const where = item.id || item.title;
    assert.ok(item.id && /^[a-z0-9-]+$/.test(item.id), `${where}: id`);
    assert.ok(TRIVIA_TAGS.includes(item.tag), `${where}: tag ${item.tag}`);
    assert.ok(item.title && item.title.length <= 60, `${where}: title`);
    assert.ok(item.story && item.story.length <= 460, `${where}: story is ${item.story?.length} characters`);
    assert.ok(item.takeaway && item.takeaway.length <= 220, `${where}: takeaway is ${item.takeaway?.length} characters`);
    // Rendered as text, so markup would show up literally; straight quotes are the house style's typographic ones.
    for (const text of [item.title, item.story, item.takeaway]) {
      assert.doesNotMatch(text, /[<>]|\s{2,}|\.\./, `${where}: stray markup or spacing`);
    }
  }
});

test('ids and titles are unique, and the stories cover India and the world', () => {
  const all = [...MARKET_STORIES, ...taxTrivia(fy)];
  assert.equal(new Set(all.map((x) => x.id)).size, all.length);
  assert.equal(new Set(all.map((x) => x.title)).size, all.length);
  assert.ok(MARKET_STORIES.length >= 40);
  assert.ok(MARKET_STORIES.filter((x) => x.tag === 'India').length >= 12);
  assert.ok(MARKET_STORIES.filter((x) => x.tag === 'World').length >= 20);
  assert.ok(MARKET_STORIES.every((x) => x.tag !== 'Tax'));
});

test('neighbouring stories change scene', () => {
  for (let i = 1; i < MARKET_STORIES.length; i += 1) {
    const [a, b] = [MARKET_STORIES[i - 1], MARKET_STORIES[i]];
    assert.ok(!(a.tag === 'India' && b.tag === 'India'), `${a.id} and ${b.id} are both Indian stories`);
  }
});

test('the tax facts name the current financial year where they depend on it', () => {
  const facts = taxTrivia(fy);
  assert.ok(facts.length >= 8);
  assert.ok(facts.some((f) => f.story.includes('FY 2026-27') && f.story.includes('February 2027')));
});

test('pools: market stories, tax facts, or both mixed with tax facts spread out', () => {
  assert.equal(triviaPool('market', fy), MARKET_STORIES);
  assert.deepEqual(triviaPool('tax', fy).map((x) => x.id), taxTrivia(fy).map((x) => x.id));
  const all = triviaPool('all', fy);
  assert.equal(all.length, MARKET_STORIES.length + taxTrivia(fy).length);
  assert.equal(new Set(all.map((x) => x.id)).size, all.length);
  for (let i = 1; i < all.length; i += 1) {
    assert.ok(!(all[i - 1].tag === 'Tax' && all[i].tag === 'Tax'), 'two tax facts in a row');
  }
});

test('the starting item moves with the day and differs between pages', () => {
  assert.equal(startIndex(10, 0, 0), 0);
  assert.equal(startIndex(10, 13, 0), 3);
  assert.equal(startIndex(10, 3, 9), 2);
  assert.equal(startIndex(10, -1, 0), 9);
  assert.equal(startIndex(0, 5, 5), 0);
  assert.notEqual(pageSeed('/Rupevo/us/'), pageSeed('/Rupevo/india/'));
});
