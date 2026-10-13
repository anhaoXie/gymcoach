import { format, resolveConfig } from 'prettier';

// Formats a rendered report the way `prettier --write` would in this repo, so
// collect.ts and render.ts write the exact bytes a later re-render reproduces.
export async function formatReport(markdown: string, filePath: string): Promise<string> {
  const config = (await resolveConfig(filePath)) ?? {};
  return format(markdown, { ...config, filepath: filePath, parser: 'markdown' });
}
