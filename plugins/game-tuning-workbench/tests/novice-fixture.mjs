import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateWorkbench } from '../scripts/generate-readonly-workbench.mjs';

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gtw-novice-test-')); const project = join(root, 'game'); const output = join(root, 'workbench');
  await mkdir(join(project, 'src'), { recursive: true });
  const config = 'export const DEFAULT_TUNING = Object.freeze({\n  player: Object.freeze({\n    walkSpeed: 5,\n  }),\n});\n';
  await writeFile(join(project, 'src/config.js'), config);
  await writeFile(join(project, 'src/story.js'), 'export const story = "星空里的冒险";\n');
  await writeFile(join(project, 'src/rules.js'), 'export const rule = "获得一分";\n');
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: '新手验收小场景', type: 'module', dependencies: { three: '*' }, scripts: { dev: 'node server.mjs', build: 'node --check src/config.js' } }));
  await writeFile(join(project, 'server.mjs'), `import {createServer} from 'node:http'; import {readFile} from 'node:fs/promises'; import {resolve} from 'node:path'; const port=Number(process.argv[process.argv.indexOf('--port')+1]);createServer(async(req,res)=>{try{if(req.url==='/favicon.ico'){res.statusCode=204;res.end();return;}const p=req.url==='/'?'index.html':req.url.slice(1);if(p.includes('..'))throw Error();res.setHeader('content-type',p.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(await readFile(resolve(p)));}catch{res.statusCode=404;res.end('not found');}}).listen(port,'127.0.0.1');`);
  await writeFile(join(project, 'index.html'), `<html lang="zh-CN"><title>新手流程验收场景</title><style>body{background:#17241b;color:#d8f5ba;font-family:sans-serif;text-align:center}canvas{border:1px solid #77946b}</style><h1>新手流程验收场景</h1><p id="story"></p><button id="play">开始游戏</button><canvas width="800" height="460"></canvas><script type="module">import{DEFAULT_TUNING}from './src/config.js';import{story}from './src/story.js';document.querySelector('#story').textContent=story;const canvas=document.querySelector('canvas');const c=canvas.getContext('2d');let x=100;function draw(){c.fillStyle='#18291e';c.fillRect(0,0,800,460);c.fillStyle='#c5ed89';c.beginPath();c.arc(x,230,25,0,Math.PI*2);c.fill();c.font='20px sans-serif';c.fillText('速度 '+DEFAULT_TUNING.player.walkSpeed+' · 方向键移动',30,45)}draw();window.addEventListener('keydown',e=>{if(e.key==='ArrowRight')x+=DEFAULT_TUNING.player.walkSpeed;if(e.key==='ArrowLeft')x-=DEFAULT_TUNING.player.walkSpeed;draw()});document.querySelector('#play').onclick=()=>{x=100;draw()};</script></html>`);
  const model = JSON.parse(await readFile(new URL('../examples/minimal-threejs-model.json', import.meta.url), 'utf8'));
  model.modelId = 'demo.novice'; model.project.root = project; model.project.name = '新手验收小场景';
  model.tuningParameters = [{ ...model.tuningParameters[0], id: 'tuning.player-speed', label: '步行速度', description: '角色每次移动的距离', currentValue: 5, safeRange: { min: 1, max: 12, step: 1 }, playerMeaning: { lower: '慢一点，更好控制', higher: '快一点，更灵活' }, sourceBinding: { file: 'src/config.js', symbol: 'DEFAULT_TUNING.player.walkSpeed', lineHint: 3, access: 'editable' }, confidence: 'confirmed' }];
  model.tuningParameters[0].unit = '步长'; model.tuningParameters[0].effects = { direct: ['改变角色移动速度'], indirect: ['躲避障碍的难度可能变化'], excluded: ['不改变敌人伤害'] };
  model.worldview.cards[0].title = '星空'; model.worldview.cards[0].body = '星空里的冒险'; model.worldview.cards[0].sourceBindings = [{ file: 'src/story.js', access: 'read-only' }];
  model.coreGameplay.rules[0].sourceBindings = [{ file: 'src/rules.js', access: 'read-only' }];
  const modelPath = join(root, 'model.json'); await writeFile(modelPath, JSON.stringify(model));
  await generateWorkbench(modelPath, output, { mode: 'apply' });
  return { root, project, output, model, config };
}
