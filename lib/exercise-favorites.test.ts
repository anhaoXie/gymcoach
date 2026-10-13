import { describe, expect, it } from 'vitest';
import { favoritesFirst } from '@/lib/exercise-favorites';

const item = (name: string, isFavorite = false) => ({ name, isFavorite });

describe('favoritesFirst (issue #404)', () => {
  it('pins favourites at the top and keeps both groups in their original order', () => {
    const list = [
      item('Bench'),
      item('Squat', true),
      item('Curl'),
      item('Deadlift', true),
      item('Row'),
    ];
    expect(favoritesFirst(list).map((e) => e.name)).toEqual([
      'Squat',
      'Deadlift',
      'Bench',
      'Curl',
      'Row',
    ]);
  });

  it('leaves a list without favourites unchanged and does not mutate the input', () => {
    const list = [item('Bench'), item('Curl')];
    const sorted = favoritesFirst(list);
    expect(sorted.map((e) => e.name)).toEqual(['Bench', 'Curl']);
    expect(sorted).not.toBe(list);
    expect(favoritesFirst([])).toEqual([]);
  });
});
