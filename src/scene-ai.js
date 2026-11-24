// The LLM's part in whitebox scenes, cut into steps small enough for a weak model. Building from the story
// documents goes layout (where the rooms are) → templates (rooms that repeat) → one room at a time (its doors,
// windows and furniture). A change asked for in words comes back as a list of named operations, never a rewritten
// scene. After every step the scene is checked (scene-model); what the step broke is sent back for another try.
// Plain Node, no Electron.
const { checkScene, buildScene, itemsOf, openingAbs, SIDES, KINDS, WALLS } = require('./scene-model');
const { resolveSetup, cameraFacts, expectProblems, factsText, castOf } = require('./scene-blocking');

const RETRIES = 2;
// a stretch of shots has many cameras to get right at once
const BLOCK_RETRIES = 4;
const clone = (v) => JSON.parse(JSON.stringify(v));
const r2 = (v) => Math.round(v * 100) / 100;

const AXES = [
  '坐标：单位米。x 往东变大，z 往南变大，y 往上。lv 是楼层，0 是一楼；每层高 levelHeight 米。',
  '片子里不出现方位，这里的东南西北只是为了把相对位置说清楚。',
].join('\n');

const ROOM_RULES = [
  '房间是一个长方形：x: [西边, 东边]，z: [北边, 南边]，都是场景坐标。墙沿着长方形四边砌，两个房间挨着就共用一面墙。',
  '同一层的房间不能重叠；楼上的房间叠在楼下房间的正上方。院子、空地写 outdoor: true（矮石墙围着、没有顶），院子里可以再放小屋。',
  '可选字段：h（这个房间的墙高，默认层高），wall（墙：plain 普通 / stone 石墙 / glass 玻璃栏杆 / wood 木墙 / none 没有墙），',
  'floor: "glass" 玻璃地板 / "none" 不铺地板，open: ["n"] 哪几面没有墙（n 北 s 南 w 西 e 东），tpl: "模板名"（格局一样的房间用同一个模板，比如一排客房）。',
  '屋顶是最上面再加一层「房间」，h 写女儿墙的高度（比如 0.9）。房间名字全场唯一，同名的加上楼层，比如「二楼楼梯」。',
].join('\n');

const ITEM_RULES = [
  '门窗和家具都用「相对房间西北角」的坐标：x 从房间西墙往东量，z 从房间北墙往南量。负数表示从另一头往回量：x: [-0.6, -0.1] 就是贴着东墙、离墙 0.1 米。',
  '门窗：{ "name", "side": "n|s|w|e", "from", "to", "sill", "top", "kind": "door|window" }。from、to 是沿着这面墙量的范围：北墙、南墙从西往东量，西墙、东墙从北往南量。门的 sill 是 0，top 一般 2.1；窗 sill 0.9 左右，top 2.2 左右。',
  '两个房间共用的墙，门只要在其中一个房间写一次，另一边会自动打通。',
  `家具：{ "name", "x": [a, b], "z": [a, b], "h": 高度, "kind" }，放在别的东西上面的写 "y": [离地, 顶] 代替 h。kind 从这些里选：${KINDS.join(' ')}。`,
  '圆的东西加 "shape": "cyl"；楼梯用 { "name": "楼梯", "shape": "stairs", "x", "z", "h": 层高, "dir": "s" }（dir 是往上走的方向）。棚子、柜子这种里面还能放东西的加 "hollow": true。',
  '家具必须整个在房间里面，彼此不能重叠；门前留出 0.6 米。伸到墙外的东西（阳台、门外的屋檐）加 "outside": true。',
  '尺寸照真实的来：单人床 0.9×2.0 米高 0.45，双人床 1.5×2.0，桌子高 0.75，椅子 0.45×0.45 高 0.45，衣柜深 0.6 高 1.8，沙发深 0.9 高 0.8，门宽 0.8–1.0。',
].join('\n');

const EXTRA_RULES = [
  'outdoor（室外的大块东西，场景坐标）：{ "name", "x": [a, b], "y": [底, 顶], "z": [a, b], "kind" }，比如地面、山壁、悬崖、车、树。kind 用 rock gravel road mountain grass water stone car 等。',
  'slopes（斜坡路）：{ "name", "from": [x, y], "to": [x, y], "z": [北, 南] }，路面从 from 的高度升到 to 的高度。',
  'lines（绳子、电线、溜索）：{ "name", "from": [x, y, z], "to": [x, y, z] }。labels（地名标注）：{ "text", "at": [x, y, z] }。',
  'people（人，1.7 米高）：{ "name", "lv", "x", "z" }，场景坐标。',
  'cameras（机位）：{ "name", "pos": [x, y, z], "target": [x, y, z], "fov": 视角, "see": ["要能看见的人或东西的名字"], "card": "素材卡代号（可选）" }。人眼高度是脚下 + 1.6。',
  '给某张场景素材卡出布局底图的机位写上 card（比如 "YS-DT"），截图会按这张卡命名，卡片拿它做图生图的底图；这种机位要像场景照片那样，站在房间一角、略高于人眼、把房间主要的东西都拍进去。',
].join('\n');

const SETUP_RULES = [
  'setups（站位：一段连续的镜头里谁在哪、每镜机位在哪）：{ "name", "room": "房间名", "shots": ["E01-015", …], "people": [ … ], "cameras": [ … ] }。',
  '站位里的人：{ "name": "人物名", "card": "身份参考图代号（比如 CJG45）", "pose": "sit|stand|crouch|lie", "by": "家具名", "side": "n|s|e|w", "along": 0–1, "facing": "看着谁 / n|s|e|w" }。',
  'by + side 是挨着哪件家具、在它的哪一边（坐在桌子北边就是 side: "n"），along 是沿着那条边的位置（北边、南边从西往东 0→1，东边、西边从北往南 0→1），软件会算出坐标。也可以直接写场景坐标 x、z。同名的家具用「名字#2」区分，按从西到东、从北到南编号。',
  'facing 写人名就是看着那个人；不写时，挨着家具的人面朝那件家具。',
  '站位里的机位：{ "name": "镜号 + 一句话", "shots": ["E01-015"], "at": { "by": "人名或家具名", "side": "behind|front|left|right（对人）或 n|s|e|w|ne|nw|se|sw", "shoulder": "left|right", "h": 相机离地高度 }, "look": "看谁" 或 ["几个人"], "frame": "特写|近景|中景|全身|远景", "expect": { … } }。',
  'frame 是 look 里第一个人的景别，软件按它算相机离多远，不用写距离。h：平视写人眼高度（站着 1.6，坐着 1.2），俯拍高一点，仰拍低一点。fov（竖直视角）一般不写，默认 40。',
  'at.side 对人用 behind（他身后，过肩拍他看着的人）、front（他面朝的那一边，拍他的脸）、left / right（他自己的左手边、右手边）。behind 时 shoulder 是从他哪边肩膀上看过去（他自己的左右）：从右肩看过去，他在画面左边做前景；从左肩看过去，他在画面右边。软件会按景别挑镜头焦距和远近。',
  'expect 写这一镜想要的构图，软件会照它核对：{ "in": [入画的人], "out": [不入画的人], "left": [在画面左半边的人], "right": [在画面右半边的人], "face": [要拍到脸的人], "back": [拍到背影的人] }。核对不上的会告诉你实际拍到什么、怎么改，你挪机位（换 at、shoulder、h、look、frame）直到对上。',
  '想拍谁的脸，相机就得在他面朝的那一边；过肩镜头就是相机在前景那个人身后（behind），看着他面对的人。',
].join('\n');

const OPS = [
  '只输出 JSON：{ "note": "一句话说改了什么", "ops": [ … ] }。每个 op 是下面一种：',
  '{ "op": "add_room", "room": { 完整的房间 } }　{ "op": "update_room", "name": "房间名", "set": { 要改的字段 } }　{ "op": "remove_room", "name": "房间名" }',
  '{ "op": "add_furniture", "room": "房间名", "item": { 完整的家具 } }　{ "op": "update_furniture", "room": "房间名", "name": "家具名", "set": { … } }　{ "op": "remove_furniture", "room": "房间名", "name": "家具名" }',
  '{ "op": "add_opening", "room": "房间名", "item": { 完整的门窗 } }　{ "op": "update_opening", "room": "房间名", "name": "门窗名", "set": { … } }　{ "op": "remove_opening", "room": "房间名", "name": "门窗名" }',
  '{ "op": "add_person" | "add_camera" | "add_outdoor", "item": { … } }　{ "op": "update_person" | "update_camera" | "update_outdoor", "name": "…", "set": { … } }　{ "op": "remove_person" | "remove_camera" | "remove_outdoor", "name": "…" }',
  '{ "op": "set_template", "name": "模板名", "template": { "openings": [ … ], "furniture": [ … ] } }',
  '{ "op": "add_setup", "item": { 完整的站位 } }　{ "op": "update_setup", "name": "站位名", "set": { 要改的字段（people、cameras 给完整的新数组） } }　{ "op": "remove_setup", "name": "站位名" }',
  'set 里只写要改的字段；改坐标就给新的完整数组。用了模板的房间，它的模板家具名字是「房间名 家具名」，要单独改一间就用 add_furniture 加一件同名（不带房间名）的覆盖它。',
].join('\n');

// ---------- JSON out of a reply ----------
function parseJson(raw) {
  const text = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('回复里没有 JSON');
  const body = text.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(body.replace(/,\s*([}\]])/g, '$1')); // the usual slip: a trailing comma
  }
}
const contentOf = (out) => (typeof out === 'string' ? out : String((out && out.content) || ''));

// Asks, checks, asks again with what was wrong: { value, raw, problems, tries }. check(value) returns the problems
// this step must not leave (strings); an empty list ends it.
async function ask(llm, messages, check, retries = RETRIES) {
  const history = [];
  let last = null;
  for (let tries = 1; tries <= retries + 1; tries++) {
    const raw = contentOf(await llm({ ...messages, history: [...(messages.history || []), ...history] }));
    let value = null;
    let problems;
    try {
      value = parseJson(raw);
      problems = check(value);
    } catch (e) {
      problems = [`JSON 读不出来：${e.message}。只输出一个 JSON 对象，不要别的文字。`];
    }
    last = { value, raw, problems, tries };
    if (!problems.length) return last;
    history.push({ role: 'user', content: messages.user }, { role: 'assistant', content: raw });
    messages = { ...messages, user: `上面的结果有这些问题：\n${problems.map((p) => `- ${p}`).join('\n')}\n请改正，重新输出完整的 JSON。` };
  }
  return last;
}

const call = (system, user, extra = {}) => ({ system, user, temperature: 0.3, maxTokens: 32768, timeoutMs: 300000, ...extra });
const docBlock = (docs) => (docs || []).map((d) => `<doc path="${d.relPath}">\n${d.content}\n</doc>`).join('\n\n');
const errorsOf = (problems, filter = () => true) => problems.filter((p) => p.level === 'error' && filter(p)).map((p) => `${p.where}：${p.message}`);
const keyOf = (p) => `${p.where}｜${p.message}`;

// ---------- named operations ----------
const byName = (list, name) => (list || []).findIndex((x) => x && x.name === name);
const ARRAYS = { person: 'people', camera: 'cameras', outdoor: 'outdoor', setup: 'setups' };

function describeOp(op) {
  const what = op.item && op.item.name ? `「${op.item.name}」` : op.name ? `「${op.name}」` : '';
  const room = op.room ? `「${op.room}」里` : '';
  const verb = { add: '加上', update: '改动', remove: '去掉', set: '设定' }[String(op.op).split('_')[0]] || op.op;
  const noun = { room: '房间', furniture: '家具', opening: '门窗', person: '人', camera: '机位', outdoor: '室外', template: '模板', setup: '站位' }[String(op.op).split('_')[1]] || '';
  const fields = op.set ? `：${Object.keys(op.set).join('、')}` : '';
  return `${verb}${room}${noun}${what}${fields}`;
}

// Applies the operations to a copy: { scene, done: [text], failed: [{ op, text, message }] }.
function applyOps(scene, ops) {
  const s = clone(scene);
  const done = [];
  const failed = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    const text = describeOp(op || {});
    const fail = (message) => failed.push({ op, text, message });
    if (!op || typeof op.op !== 'string') { fail('不是一个 op'); continue; }
    const [verb, noun] = op.op.split('_');
    const roomOf = () => s.rooms.find((r) => r.name === op.room);
    if (noun === 'room') {
      const i = byName(s.rooms, verb === 'add' ? op.room && op.room.name : op.name);
      if (verb === 'add') { if (!op.room || !op.room.name) { fail('没有房间内容'); continue; } if (i >= 0) { fail(`已经有「${op.room.name}」了`); continue; } s.rooms.push(op.room); }
      else if (i < 0) { fail(`没有叫「${op.name}」的房间`); continue; }
      else if (verb === 'update') {
        Object.assign(s.rooms[i], op.set || {});
        if (op.set && op.set.name && op.set.name !== op.name) { // the room's people and camera targets keep pointing at it
          for (const c of s.cameras || []) if (Array.isArray(c.see)) c.see = c.see.map((n) => (n === op.name ? op.set.name : n));
        }
      } else if (verb === 'remove') s.rooms.splice(i, 1);
      else { fail('不认识的 op'); continue; }
    } else if (noun === 'furniture' || noun === 'opening') {
      const room = roomOf();
      if (!room) { fail(`没有叫「${op.room}」的房间`); continue; }
      const key = noun === 'furniture' ? 'furniture' : 'openings';
      room[key] = Array.isArray(room[key]) ? room[key] : [];
      if (verb === 'add') {
        if (!op.item || !op.item.name) { fail('没有内容'); continue; }
        const i = byName(room[key], op.item.name);
        if (i >= 0) room[key][i] = op.item; else room[key].push(op.item);
      } else {
        let i = byName(room[key], op.name);
        if (i < 0 && room.tpl) { // a template's item, changed in this room only: copy it in first
          const t = itemsOf(room, s.templates, key).find((x) => x.fromTpl && (x.name === op.name || x.name === `${room.name} ${op.name}`));
          if (t) {
            const { fromTpl, ...item } = t;
            item.name = item.name.replace(`${room.name} `, '');
            room[key].push(item);
            i = room[key].length - 1;
          }
        }
        if (i < 0) { fail(`「${op.room}」里没有「${op.name}」`); continue; }
        if (verb === 'update') Object.assign(room[key][i], op.set || {});
        else if (verb === 'remove') {
          if (room.tpl && itemsOf({ ...room, [key]: [] }, s.templates, key).some((x) => x.name === `${room.name} ${op.name}` || x.name === op.name)) {
            fail('这是模板里的东西，单独一间去不掉；要整排都去掉，改模板（set_template）'); continue;
          }
          room[key].splice(i, 1);
        } else { fail('不认识的 op'); continue; }
      }
    } else if (ARRAYS[noun]) {
      const list = (s[ARRAYS[noun]] = Array.isArray(s[ARRAYS[noun]]) ? s[ARRAYS[noun]] : []);
      if (verb === 'add') {
        if (!op.item || !op.item.name) { fail('没有内容'); continue; }
        const i = byName(list, op.item.name);
        if (i >= 0) list[i] = op.item; else list.push(op.item);
      } else {
        const i = byName(list, op.name);
        if (i < 0) { fail(`没有「${op.name}」`); continue; }
        if (verb === 'update') Object.assign(list[i], op.set || {});
        else if (verb === 'remove') list.splice(i, 1);
        else { fail('不认识的 op'); continue; }
      }
    } else if (op.op === 'set_template') {
      if (!op.name || !op.template) { fail('要有 name 和 template'); continue; }
      s.templates = s.templates || {};
      s.templates[op.name] = { openings: op.template.openings || [], furniture: op.template.furniture || [] };
    } else { fail('不认识的 op'); continue; }
    done.push(text);
  }
  return { scene: s, done, failed };
}

// ---------- a change asked for in words ----------
// { ok, note, ops, done, failed, scene, problems (all of the new scene), added (problems it did not have before), tries }
async function editScene({ scene, remark, focus = '', llm }) {
  const before = new Set(checkScene(scene).map(keyOf));
  const system = [
    '你在改一个白模场景（建筑和周围环境的方块模型），用来给短剧定空间关系。用户用一句话说要怎么改，你给出修改操作。',
    AXES, ROOM_RULES, ITEM_RULES, EXTRA_RULES, SETUP_RULES, OPS,
    '只改用户说的；其他房间、家具一律不动。动一样东西会撞到别的（家具重叠、挡门、出了房间），就把别的也一起挪开。',
  ].join('\n\n');
  const user = [
    `现在的场景（JSON）：\n${JSON.stringify(scene)}`,
    focus ? `只改房间「${focus}」里的东西，除非用户明确说了别的房间。` : '',
    `用户要改的：${remark}`,
  ].filter(Boolean).join('\n\n');
  let outcome = null;
  const r = await ask(llm, call(system, user), (value) => {
    if (!value || !Array.isArray(value.ops)) return ['要有 "ops" 数组'];
    if (!value.ops.length) return [];
    outcome = applyOps(scene, value.ops);
    const added = checkScene(outcome.scene).filter((p) => p.level === 'error' && !before.has(keyOf(p)));
    return [
      ...outcome.failed.map((f) => `${f.text} 没做成：${f.message}`),
      ...added.map((p) => `改完以后 ${p.where}：${p.message}`),
    ];
  });
  if (!r.value || !Array.isArray(r.value.ops)) return { ok: false, message: 'AI 没给出能用的修改，换个说法再试一次' };
  const result = outcome && r.value.ops.length ? outcome : { scene: clone(scene), done: [], failed: [] };
  const problems = checkScene(result.scene);
  return {
    ok: true, note: String(r.value.note || ''), ops: r.value.ops, done: result.done, failed: result.failed,
    scene: result.scene, problems, added: problems.filter((p) => !before.has(keyOf(p))), tries: r.tries,
  };
}

// ---------- blocking a stretch of shots ----------
// One room as the blocking step sees it: its walls and what is in them, its furniture with where it stands
// (scene coordinates), names that repeat numbered the way the setup refers to them.
function roomBrief(scene, roomName) {
  const room = scene.rooms.find((r) => r.name === roomName);
  if (!room) return '';
  const built = buildScene(scene);
  const mine = built.boxes.filter((b) => b.room === roomName && b.name && !b.wall && !b.floor);
  const counts = new Map();
  for (const b of mine) counts.set(b.name, (counts.get(b.name) || 0) + 1);
  const seen = new Map();
  const sorted = [...mine].sort((a, b) => a.x0 - b.x0 || a.z0 - b.z0);
  const lines = sorted.map((b) => {
    const k = (seen.get(b.name) || 0) + 1;
    seen.set(b.name, k);
    const label = counts.get(b.name) > 1 ? `${b.name}#${k}` : b.name;
    const kind = b.opening ? (b.kind === 'glass' ? '窗' : '门') : '家具';
    return `- 「${label}」（${kind}）x ${r2(b.x0)}–${r2(b.x1)}，z ${r2(b.z0)}–${r2(b.z1)}，高 ${r2(b.y0 - room.lv * built.levelHeight)}–${r2(b.y1 - room.lv * built.levelHeight)} 米`;
  });
  return [
    `房间「${roomName}」：${room.lv + 1}楼，x ${room.x[0]}–${room.x[1]}（西→东），z ${room.z[0]}–${room.z[1]}（北→南）。`,
    `四面墙：\n${sideOwners(scene, room)}`,
    `里面的东西（场景坐标）：\n${lines.join('\n')}`,
  ].join('\n');
}

// A setup for the given shots, written by the model and checked here: people placed, every camera able to show
// what its expect asks. → { ok, scene (with the setup in), setup, facts: { camera: text }, problems, tries }
async function blockShots({ scene, name, room, shots, notes = '', remark = '', llm }) {
  if (!scene.rooms.some((r) => r.name === room)) return { ok: false, message: `没有叫「${room}」的房间` };
  const system = [
    '你在给短剧的一段连续镜头排站位：人坐在哪、站在哪、朝哪，每一镜的相机放在哪、看谁。排好以后软件会算出每一镜画面里谁在左谁在右、拍到脸还是背影，写提示词时照它写，前后镜头的位置就不会乱。',
    AXES, SETUP_RULES,
    '只输出 JSON：{ "note": "一句话说怎么排的", "setup": { 完整的站位 } }。',
    '先定人：整段戏里人的位置不变（除非剧本写了谁走动，那就分成两个站位）。再定机位：每一镜一个机位，按分镜写的景别和谁是主体来放，每个机位都写 expect。',
    '分镜原文里的「画面左」「画面右」「面朝镜头」如果和人的位置矛盾，以人的位置为准，挪机位去满足它想拍的人和景别，不要为了一镜挪人。',
    '每镜的「人物参考图」就是这一镜里出现的人，他们都要入画（前景虚着、背对镜头也算）。expect 照分镜原文想要的构图写，前景是谁、谁在哪半边都写上；不要为了通过核对删掉要求，实在做不到的在 note 里说。',
    '相机不能站进人身上：离人至少 0.3 米，或者高过他头顶。',
  ].join('\n\n');
  const castLine = (s) => {
    const names = (s.references || []).filter((r) => /身份/.test(r.use || '')).map((r) => String(r.title || r.id).replace(/\s*角色板$/, ''));
    return names.length ? ` 人物参考图="${names.join('、')}"` : '';
  };
  const user = [
    roomBrief(scene, room),
    `站位名字：${name}。要排的镜头：\n${shots.map((s) => `<shot id="${s.id}"${castLine(s)}>\n${s.text}\n</shot>`).join('\n')}`,
    notes ? `剧本里关于站位的说明：\n${notes}` : '',
    remark ? `用户的要求：${remark}` : '',
  ].filter(Boolean).join('\n\n');
  // the try with the fewest problems is kept: a later one can be worse
  let best = null;
  const evaluate = (setup, note) => {
    setup.name = name;
    setup.room = room;
    const next = clone(scene);
    next.setups = (next.setups || []).filter((x) => x && x.name !== name);
    next.setups.push(setup);
    const built = buildScene(next);
    const resolved = resolveSetup(next, setup, built);
    const problems = resolved.problems.map((p) => p.message);
    for (const s of shots) {
      const tail = s.id.replace(/^(?:MOTION|HAND)-/i, '');
      if (!resolved.cameras.some((c) => c.shots.some((k) => s.id.toUpperCase().endsWith(String(k).toUpperCase())))) problems.push(`${tail} 没有机位（机位的 shots 里写 "${tail}"）`);
    }
    for (const c of resolved.cameras) {
      if (!c.expect) { problems.push(`机位「${c.name}」没写 expect`); continue; }
      const facts = cameraFacts(next, resolved, c, built);
      problems.push(...expectProblems(facts, c.expect));
      // the shot's identity pictures say who is in it: each of them has to be in the picture
      for (const s of shots.filter((x) => c.shots.some((k) => x.id.toUpperCase().endsWith(String(k).toUpperCase())))) {
        for (const p of castOf(s.references, resolved.people)) {
          const f = facts.people.find((x) => x.name === p.name);
          if (f && f.frame === 'out') {
            const way = { behind: '在相机后面', below: '从画面下边出画了（把 h 降低一点）', above: '从画面上边出画了（把 h 抬高一点）' }[f.outBy] || '在画面外（look 里加上他，或者换个 at 让他入画）';
            problems.push(`机位「${c.name}」：${s.id.slice(-3)} 挂了${p.name}的参考图（这一镜有他），可从这个位置拍，${p.name}${way}`);
          }
        }
      }
    }
    // the bracketed "what it shows now" lines are help for the model, not problems of their own
    const count = problems.filter((p) => !p.startsWith('（')).length;
    if (!best || count < best.count) best = { next, resolved, count, problems, note: note || (best && best.note) || '' };
    return problems;
  };
  // a setup of that name already in the scene is kept and only its wrong cameras are redone, unless asked otherwise
  const existing = !remark && (scene.setups || []).find((x) => x && x.name === name);
  const r = existing ? (evaluate(clone(existing), '在原来的站位上只改没对上的机位'), { tries: 0 }) : await ask(llm, call(system, user), (value) => {
    if (!value || !value.setup || typeof value.setup !== 'object') return ['要有 "setup" 对象'];
    return evaluate(value.setup, String(value.note || ''));
  }, BLOCK_RETRIES);
  if (!best) return { ok: false, message: 'AI 没排出能用的站位' };
  // the cameras still wrong are asked for again on their own, the people and the other cameras kept as they are
  let tries = r.tries;
  for (let round = 0; round < 2 && best.count; round++) {
    const bad = [...new Set(best.problems.map((p) => (/^机位「([^」]+)」/.exec(p) || [])[1]).filter(Boolean))];
    if (!bad.length) break;
    const current = best.next.setups.find((x) => x.name === name);
    const theirShots = shots.filter((s) => current.cameras.some((c) => bad.includes(c.name) && (c.shots || []).some((k) => s.id.toUpperCase().endsWith(String(k).toUpperCase()))));
    const fixUser = [
      roomBrief(scene, room),
      `现在的站位（JSON，人的位置定了，不要动）：\n${JSON.stringify(current)}`,
      `这几个机位还没对上：\n${best.problems.join('\n')}`,
      `这几个机位拍的镜头：\n${theirShots.map((s) => `<shot id="${s.id}"${castLine(s)}>\n${s.text}\n</shot>`).join('\n')}`,
      `只重写这几个机位：${bad.map((b) => `「${b}」`).join('、')}，名字不变。只输出 JSON：{ "note": "一句话", "cameras": [ 改好的机位 ] }。`,
    ].join('\n\n');
    const fixed = await ask(llm, call(system, fixUser), (value) => {
      if (!value || !Array.isArray(value.cameras)) return ['要有 "cameras" 数组'];
      const merged = clone(current);
      merged.cameras = merged.cameras.map((c) => value.cameras.find((n) => n && n.name === c.name) || c);
      return evaluate(merged, '');
    }, 2);
    tries += fixed.tries;
  }
  const { next, resolved } = best;
  const built = buildScene(next);
  const facts = Object.fromEntries(resolved.cameras.map((c) => [c.name, factsText(cameraFacts(next, resolved, c, built))]));
  return {
    ok: true, scene: next, setup: next.setups.find((x) => x.name === name), note: best.note, facts,
    problems: best.problems.filter((p) => !p.startsWith('（')), tries,
  };
}

// ---------- building from the documents ----------
function sideOwners(scene, room) {
  // who is on the other side of each wall: neighbouring rooms of the same floor, or 外面
  const rooms = scene.rooms.filter((r) => r !== room && r.lv === room.lv);
  const [x1, x2] = room.x;
  const [z1, z2] = room.z;
  const touch = (side) => rooms.filter((r) => {
    const ox = Math.min(x2, r.x[1]) - Math.max(x1, r.x[0]);
    const oz = Math.min(z2, r.z[1]) - Math.max(z1, r.z[0]);
    if (side === 'n') return Math.abs(r.z[1] - z1) < 0.05 && ox > 0.3;
    if (side === 's') return Math.abs(r.z[0] - z2) < 0.05 && ox > 0.3;
    if (side === 'w') return Math.abs(r.x[1] - x1) < 0.05 && oz > 0.3;
    return Math.abs(r.x[0] - x2) < 0.05 && oz > 0.3;
  }).map((r) => {
    const span = side === 'n' || side === 's'
      ? [Math.max(x1, r.x[0]) - x1, Math.min(x2, r.x[1]) - x1] : [Math.max(z1, r.z[0]) - z1, Math.min(z2, r.z[1]) - z1];
    return `「${r.name}」（这面墙的 ${r2(span[0])}–${r2(span[1])} 米）`;
  });
  const name = { n: '北墙', s: '南墙', w: '西墙', e: '东墙' };
  return SIDES.map((s) => {
    const who = touch(s);
    return `${name[s]}（长 ${r2(s === 'n' || s === 's' ? x2 - x1 : z2 - z1)} 米）外面：${who.length ? who.join('、') : '室外'}`;
  }).join('\n');
}

// Doors and windows other rooms already put in this room's walls, in this room's own measures.
function openingsFromNeighbours(scene, room) {
  const out = [];
  for (const r of scene.rooms) {
    if (r === room || r.lv !== room.lv) continue;
    for (const o of itemsOf(r, scene.templates, 'openings')) {
      if (!o || !SIDES.includes(o.side) || typeof o.from !== 'number' || typeof o.to !== 'number') continue;
      const a = openingAbs(r, o);
      for (const s of SIDES) {
        const line = { n: room.z[0], s: room.z[1], w: room.x[0], e: room.x[1] }[s];
        const wall = s === 'n' || s === 's' ? 'z' : 'x';
        const base = wall === 'z' ? room.x[0] : room.z[0];
        const size = wall === 'z' ? room.x[1] - room.x[0] : room.z[1] - room.z[0];
        if (a.wall === wall && Math.abs(a.at - line) < 0.05 && a.to - base > 0.05 && a.from - base < size - 0.05) {
          out.push(`${{ n: '北墙', s: '南墙', w: '西墙', e: '东墙' }[s]} ${r2(a.from - base)}–${r2(a.to - base)} 米：「${a.name}」（${r.name} 开的${a.kind === 'window' ? '窗' : '门'}）`);
        }
      }
    }
  }
  return out;
}

// The documents open the system prompt, before the rules of the step: a whole build (the layout, then every room)
// starts each call with the same text, and the service's prompt cache covers it from the second call on. The
// furnishing system prompt is one fixed text for a room, a floor and a template; what each wants back is in the
// user message.
const DOCS_FIRST = (docs) => (docs && docs.length ? `下面是剧本里的设定文档，后面的任务按它们来：\n\n${docBlock(docs)}` : '');

const FURNISH_SYSTEM = (docs) => [
  DOCS_FIRST(docs),
  '你在给白模场景里的房间开门窗、摆家具，用来给短剧定空间关系：谁站在哪、从哪个门进出、窗外看得到什么。要摆哪个房间、输出什么样的 JSON，写在请求里。',
  AXES, ITEM_RULES,
  '门窗只写这个房间自己的墙上要新开的；邻居已经开好的不要重复。',
  '房间要能进：至少有一扇门通到相邻的房间或室外（邻居已经开在共用墙上的门也算）。文档里提到的东西都要摆进去，名字照文档写，人物的东西写清楚是谁的（比如「何遇的床」）。',
].filter(Boolean).join('\n\n');

const ONE_ROOM_JSON = '只输出 JSON：{ "openings": [ … ], "furniture": [ … ] }。';
const LEVEL_JSON = '只输出 JSON：{ "rooms": { "房间名": { "openings": [ … ], "furniture": [ … ] }, … } }，上面列出的每个房间都要有。同一层的房间一起摆：两个房间之间的门只在其中一个房间写一次。';

function furnishUser(scene, room, remark) {
  const w = r2(room.x[1] - room.x[0]);
  const d = r2(room.z[1] - room.z[0]);
  const nb = openingsFromNeighbours(scene, room);
  return [
    `场景：${scene.name}。房间「${room.name}」，在${room.lv + 1}楼${room.outdoor ? '（室外的院子，没有顶）' : ''}，东西宽 ${w} 米、南北深 ${d} 米、墙高 ${room.h || scene.levelHeight} 米。`,
    `场景坐标：x ${room.x[0]}–${room.x[1]}，z ${room.z[0]}–${room.z[1]}（只用来对照文档里的方位；你写的坐标都相对这个房间的西北角）。`,
    `四面墙：\n${sideOwners(scene, room)}`,
    nb.length ? `邻居已经开在这个房间墙上的门窗（会自动打通，不用再写）：\n${nb.join('\n')}` : '',
    remark ? `用户的要求：${remark}` : '',
  ].filter(Boolean).join('\n\n');
}

// Doors, windows and furniture of one room, checked against the whole scene: the new scene and its room's problems.
async function furnishRoom({ scene, roomName, docs, remark = '', llm }) {
  const room = scene.rooms.find((r) => r.name === roomName);
  if (!room) return { ok: false, message: `没有叫「${roomName}」的房间` };
  const mine = (p) => p.where.startsWith(`房间「${roomName}」`);
  let next = scene;
  const r = await ask(llm, call(FURNISH_SYSTEM(docs), `${furnishUser(scene, room, remark)}\n\n${ONE_ROOM_JSON}`), (value) => {
    if (!value || !Array.isArray(value.furniture)) return ['要有 "furniture" 数组（没有家具也写空数组）'];
    next = clone(scene);
    const target = next.rooms.find((x) => x.name === roomName);
    target.openings = Array.isArray(value.openings) ? value.openings : [];
    target.furniture = value.furniture;
    return errorsOf(checkScene(next), mine);
  });
  if (!r.value) return { ok: false, message: `「${roomName}」AI 没给出能用的结果` };
  return { ok: true, scene: next, problems: checkScene(next).filter(mine), tries: r.tries };
}

// All the given rooms of one floor in one call: { ok, scene, left: names still with errors after the retries }.
async function furnishLevel({ scene, lv, names, docs, llm }) {
  const rooms = names.map((n) => scene.rooms.find((r) => r.name === n)).filter(Boolean);
  const system = FURNISH_SYSTEM(docs);
  const user = [
    `场景：${scene.name}，${lv + 1}楼。这一层要摆的房间：`,
    ...rooms.map((r) => furnishUser(scene, r, '')),
    LEVEL_JSON,
  ].join('\n\n---\n\n');
  const mine = (p) => rooms.some((r) => p.where.startsWith(`房间「${r.name}」`));
  let next = scene;
  const r = await ask(llm, call(system, user), (value) => {
    if (!value || typeof value.rooms !== 'object' || !value.rooms) return ['要有 "rooms" 对象，键是房间名'];
    const missing = rooms.filter((x) => !value.rooms[x.name]).map((x) => x.name);
    next = clone(scene);
    for (const x of rooms) {
      const got = value.rooms[x.name];
      if (!got) continue;
      const target = next.rooms.find((t) => t.name === x.name);
      target.openings = Array.isArray(got.openings) ? got.openings : [];
      target.furniture = Array.isArray(got.furniture) ? got.furniture : [];
    }
    return [...missing.map((m) => `少了房间「${m}」`), ...errorsOf(checkScene(next), mine)];
  });
  if (!r.value || !r.value.rooms) return { ok: false, message: `${lv + 1} 楼 AI 没给出能用的结果` };
  const bad = new Set(checkScene(next).filter((p) => p.level === 'error' && mine(p)).map((p) => /房间「([^」]+)」/.exec(p.where)[1]));
  const left = rooms.filter((x) => bad.has(x.name) || !r.value.rooms[x.name]).map((x) => x.name);
  return { ok: true, scene: next, left, tries: r.tries };
}

async function furnishTemplate({ scene, name, docs, llm }) {
  const users = scene.rooms.filter((r) => r.tpl === name);
  if (!users.length) return { ok: true, scene };
  const sample = users.reduce((a, b) => ((a.x[1] - a.x[0]) * (a.z[1] - a.z[0]) <= (b.x[1] - b.x[0]) * (b.z[1] - b.z[0]) ? a : b));
  const sizes = [...new Set(users.map((r) => `${r2(r.x[1] - r.x[0])}×${r2(r.z[1] - r.z[0])}`))].join('、');
  const user = [
    `模板「${name}」给这些格局一样的房间用：${users.map((r) => r.name).join('、')}。它们的大小（东西×南北）有：${sizes} 米。`,
    '下面按其中最小的一间来摆。贴着东墙、南墙的东西用负数从另一头量，这样大一点的房间也放得下。门窗名字、家具名字不用带房间号。',
    furnishUser(scene, sample, ''),
    ONE_ROOM_JSON,
  ].join('\n\n');
  const theirs = (p) => users.some((r) => p.where.startsWith(`房间「${r.name}」`));
  let next = scene;
  const r = await ask(llm, call(FURNISH_SYSTEM(docs), user), (value) => {
    if (!value || !Array.isArray(value.furniture)) return ['要有 "furniture" 数组'];
    next = clone(scene);
    next.templates[name] = { openings: Array.isArray(value.openings) ? value.openings : [], furniture: value.furniture };
    return errorsOf(checkScene(next), theirs);
  });
  if (!r.value) return { ok: false, message: `模板「${name}」AI 没给出能用的结果` };
  return { ok: true, scene: next, tries: r.tries };
}

const LAYOUT_KEYS = ['levelHeight', 'rooms', 'outdoor', 'slopes', 'lines', 'labels', 'people', 'cameras'];

async function layoutFromDocs({ name, docs, remark = '', llm }) {
  const system = [
    DOCS_FIRST(docs),
    '你在按上面的设定文档搭一个白模场景（建筑和周围环境的方块模型），用来给短剧定空间关系。这一步只排房间的位置和大小，以及室外的地形、人、机位；门窗和家具下一步再摆。',
    AXES, ROOM_RULES, EXTRA_RULES,
    `只输出 JSON：{ ${LAYOUT_KEYS.map((k) => `"${k}"`).join(', ')} }。rooms 里每个房间只写 name、lv、x、z 和需要的 h、wall、floor、open、outdoor、tpl。`,
    '先想清楚整栋楼多长多宽、每层怎么分，再写数字：同一层的房间拼起来正好铺满楼的平面，不重叠、不留缝（走廊也是房间）。文档里写了的尺寸照写，没写的按常理定。',
    '机位：文档里写到的「从哪儿看哪儿」都做成机位，see 里写要看见的人或东西。',
  ].filter(Boolean).join('\n\n');
  const user = `按文档搭「${name}」。${remark ? `另外：${remark}` : ''}`;
  let scene = null;
  const r = await ask(llm, call(system, user), (value) => {
    if (!value || !Array.isArray(value.rooms) || !value.rooms.length) return ['要有 "rooms" 数组，至少一个房间'];
    scene = {
      version: 1, name, code: '', levelHeight: typeof value.levelHeight === 'number' ? value.levelHeight : 3,
      rooms: value.rooms.map((x) => ({ ...x, openings: [], furniture: [] })),
      templates: {}, outdoor: value.outdoor || [], slopes: value.slopes || [], lines: value.lines || [], labels: value.labels || [],
      people: value.people || [], cameras: value.cameras || [],
    };
    for (const t of new Set(scene.rooms.map((x) => x.tpl).filter(Boolean))) scene.templates[t] = { openings: [], furniture: [] };
    // at this step only the rooms' own places count: no doors exist yet, people and cameras come back later
    return errorsOf(checkScene(scene), (p) => /^房间|^场景/.test(p.where) && !/门|家具/.test(p.message));
  });
  if (!scene) return { ok: false, message: 'AI 没排出能用的房间布局' };
  return { ok: true, scene, tries: r.tries };
}

// The whole build: { ok, scene, problems }. onProgress({ step, done, total, text }) after every call.
async function buildFromDocs({ name, docs, remark = '', llm, onProgress = () => {} }) {
  onProgress({ step: 'layout', done: 0, total: 1, text: '排房间的位置' });
  const laid = await layoutFromDocs({ name, docs, remark, llm });
  if (!laid.ok) return laid;
  let scene = laid.scene;
  const templates = Object.keys(scene.templates);
  const rooms = scene.rooms.filter((r) => !r.tpl && r.wall !== 'glass').map((r) => r.name);
  const total = 1 + templates.length + rooms.length;
  let done = 1;
  const skipped = [];
  for (const t of templates) {
    onProgress({ step: 'template', done, total, text: `模板「${t}」` });
    const r = await furnishTemplate({ scene, name: t, docs, llm });
    if (r.ok) scene = r.scene; else skipped.push(r.message);
    done++;
  }
  // one floor per call: the rooms of a floor agree on the doors between them; a floor that will not come out
  // right falls back to one room at a time
  const levels = [...new Set(scene.rooms.filter((r) => rooms.includes(r.name)).map((r) => r.lv))].sort((a, b) => a - b);
  for (const lv of levels) {
    const names = scene.rooms.filter((r) => r.lv === lv && rooms.includes(r.name)).map((r) => r.name);
    onProgress({ step: 'level', done, total, text: `${lv + 1} 楼：${names.map((n) => `「${n}」`).join('')}` });
    const r = await furnishLevel({ scene, lv, names, docs, llm });
    if (r.ok) scene = r.scene;
    if (!r.ok || r.left.length) {
      for (const roomName of r.ok ? r.left : names) {
        onProgress({ step: 'room', done, total, text: `重摆「${roomName}」` });
        const one = await furnishRoom({ scene, roomName, docs, llm });
        if (one.ok) scene = one.scene; else skipped.push(one.message);
      }
    }
    done += names.length;
  }
  onProgress({ step: 'done', done: total, total, text: '完成' });
  return { ok: true, scene, problems: checkScene(scene), skipped };
}

module.exports = { parseJson, applyOps, describeOp, editScene, blockShots, roomBrief, furnishRoom, furnishLevel, furnishTemplate, layoutFromDocs, buildFromDocs, sideOwners, openingsFromNeighbours, WALLS };
