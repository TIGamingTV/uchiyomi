// Notice chapters in the web app (bff lib/noticeChapters.ts): the per-type switches in Admin → Settings, the
// per-series switch in the Sources & translations sheet, and the series type in Edit series. Reads the source as
// text, as the other settings tests do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SERIES_TYPES, seriesTypeKey } from '../lib/seriesTypes';

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

test('one switch per series type, the server\'s six in its order, each with a label', () => {
  assert.deepEqual([...SERIES_TYPES], ['manga', 'manhwa', 'manhua', 'webtoon', 'comic', 'unknown']);
  assert.deepEqual(SERIES_TYPES.map(seriesTypeKey), ['Manga', 'Manhwa', 'Manhua', 'Webtoon', 'Comic', 'Unknown / other']);
});

test('Admin → Settings: the section comes after the pinned ones and saves the list whole', () => {
  const src = read('components/AdminSettings.tsx');
  const grid = src.slice(src.indexOf('<div className={SETTINGS_GRID}>\n      <ServerSection'));
  assert.match(grid, /<SourceOrderSection [^\n]*\/>\s*<NoticeChaptersSection /, 'Notice chapters is not last, after the source order');
  const section = src.slice(src.indexOf('function NoticeChaptersSection('));
  assert.match(section, /save\(\{ hideNoticeTypes: next \}\)/, 'the section does not PATCH hideNoticeTypes');
  // Held locally and rolled back on a failed save, so two quick flips do not undo each other.
  assert.match(section, /setTypes\(prev\)/);
  assert.match(section, /SERIES_TYPES\.map/);
});

test('the Sources & translations sheet: what applies, its own choice, and the way back to the type', () => {
  const src = read('components/SourcesSheet.tsx');
  assert.match(src, /method: 'PATCH', json: \{ hideNotices: on \}/);
  assert.match(src, /checked=\{series\.hideNoticesEffective\}/, 'the box must show what applies, not only the series\' own value');
  assert.match(src, /setHideNotices\(null\)/, 'no way back to the type\'s switch');
  assert.match(src, /'series-books'/, 'the chapter list is not refetched after a flip');
});

test('Edit series: the type is sent, null for automatic, seeded from the override only', () => {
  const src = read('app/series/page.tsx');
  assert.match(src, /useState<string>\(series\.overrides\?\.seriesType \?\? ''\)/);
  assert.match(src, /seriesType: seriesType \|\| null/);
});
