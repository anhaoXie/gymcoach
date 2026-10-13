// Favourite exercises (issue #404) are pinned at the top of a list. The sort
// is stable: favourites keep their relative order, and so does the rest, so a
// caller's ordering (by muscle group then name, or a search match) survives.
export function favoritesFirst<T extends { isFavorite: boolean }>(items: readonly T[]): T[] {
  return [...items.filter((item) => item.isFavorite), ...items.filter((item) => !item.isFavorite)];
}
