import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBundleSchema } from '@/automation/records/schema';
import { type ReportMeta, renderReport } from '@/automation/baseline/report';

// Re-renders report.md from a collected runs.jsonl and meta.json, without
// calling GitHub again:  npx tsx automation/baseline/render.ts <dir>
const dir = process.argv[2];
if (!dir) throw new Error('Usage: render.ts <dir>');
const bundles = readFileSync(join(dir, 'runs.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => runBundleSchema.parse(JSON.parse(line)));
const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as ReportMeta;
writeFileSync(join(dir, 'report.md'), renderReport(bundles, meta));
console.log(`Rendered ${bundles.length} runs`);
