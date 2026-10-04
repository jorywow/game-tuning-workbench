import assert from 'node:assert/strict';
import { rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './novice-fixture.mjs';
import { RuntimePreviewService } from '../scripts/runtime-preview-service.mjs';

const f = await fixture(); let preview;
try {
  preview = await new RuntimePreviewService({ model: f.model, projectRoot: f.project }).initialize();
  const before = await readFile(join(f.project, 'src/story.js'), 'utf8'); const after = before.replace('星空', '海底');
  const changeSet = { summary: '故事修改', operations: [{ sourceBinding: { file: 'src/story.js' }, type: 'edit-worldview' }] };
  const result = await preview.startPrepared(changeSet, [{ path: 'src/story.js', before, after }]);
  assert.equal(await fetch(`${result.session.baselineUrl}src/story.js`).then(r => r.text()), before);
  assert.equal(await fetch(`${result.session.draftUrl}src/story.js`).then(r => r.text()), after);
  assert.equal(await readFile(join(f.project, 'src/story.js'), 'utf8'), before);
  assert.equal(result.sourceUnchanged, true);
  await assert.rejects(preview.startPrepared(changeSet, [{ path: '../escape.js', before, after }]));
  console.log('Complex preview passed: original vs proposed story, source unchanged, unsafe path blocked.');
} finally { await preview?.stop(); await rm(f.root, { recursive: true, force: true }); }
