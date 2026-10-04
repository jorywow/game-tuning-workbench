import { readFile } from 'node:fs/promises';

// Portable synthetic model: release tests must never depend on someone's private game snapshot.
export async function portableExampleModel() {
  const model = JSON.parse(await readFile(new URL('../examples/minimal-threejs-model.json', import.meta.url), 'utf8'));
  model.modelId = 'demo.portable-example';
  const second = structuredClone(model.tuningParameters[0]);
  second.id = 'tuning.enemy-second-window'; second.label = '第二阶段反应时间'; second.sourceBinding.symbol = 'enemySettings.secondWarningSeconds';
  model.tuningParameters.push(second);
  model.assets[0].technicalContract = { kind: 'generated-runtime', acceptedMimeTypes: [] };
  return model;
}
