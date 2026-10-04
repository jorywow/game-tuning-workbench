import test from 'node:test';
import assert from 'node:assert/strict';
import { plainLanguage } from '../assets/workbench/novice-copy.js';

test('beginner copy removes immediate-effect promises and translates runtime jargon without changing user intent', () => {
  assert.equal(plainLanguage('步行速度，原项目标注为“立即”生效。'), '步行速度');
  assert.equal(plainLanguage('HUD、画面后处理'), '屏幕提示、画面效果');
  assert.equal(plainLanguage('对应运行时事件已触发'), '上面这件事已经发生');
  assert.equal(plainLanguage('射速 RPM'), '每分钟射击次数');
  assert.equal(plainLanguage('命中后恢复 5 点生命'), '命中后恢复 5 点生命');
});
