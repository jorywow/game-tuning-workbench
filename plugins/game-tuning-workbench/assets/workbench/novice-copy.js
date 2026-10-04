export function plainLanguage(value) {
  return String(value ?? '')
    .replace(/，原项目标注为“[^”]+”生效。?/g, '')
    .replaceAll('对应运行时事件已触发', '上面这件事已经发生')
    .replaceAll('运行时数值', '设置')
    .replaceAll('源码证据', '游戏中的对应内容')
    .replaceAll('HUD', '屏幕提示')
    .replaceAll('画面后处理', '画面效果')
    .replaceAll('射速 RPM', '每分钟射击次数')
    .replace(/\bRPM\b/g, '发/分钟');
}

export const parameterGroups = {
  controls: '移动与操作', 'combat-pressure': '战斗与敌人', pacing: '游戏节奏',
  rewards: '成长与奖励', forgiveness: '难度与容错', 'visual-feedback': '画面与声音',
};
