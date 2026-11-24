const SECTIONS = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];
const H3_SECTIONS = `保持 MiniMax H3 full-reference 六段顺序：${SECTIONS.join('、')}。六段是一条提示词。`;
const H3_TAGS = '<Picture N> 必须与用户给出的参考图顺序一致，参考图数量为 0 时不新增任何 <Picture N>；<Subject N> 和说话人 ID 稳定，不留下未定义标签。';
const H3_DIALOGUE = '结构字段用英文；中文对白逐字保留为 <d>[Chinese] 逐字台词</d>，不翻译、不添加外语开场句。';
const H3_ANCHORS = '锚点按用途区分：身份只控制人物身份，地理只控制空间关系，起始帧只控制开场构图与姿态，不让参考图越权控制动作或表情。';
const H3_SOUND = 'overall_soundscape 只写环境声与物理音效；没有非画内配乐时写 non_diegetic_music: N/A。';
const { negations } = require('./prompt-hygiene');

const numbered = (rules, from) => rules.map((rule, index) => `${from + index}. ${rule}`).join('\n');

// H3 carries out every action it reads, so a shot with more actions than seconds comes out hurried
const H3_PACE = '节奏：模型会把写下的每个人物动作都做完，动作多了就一个赶一个。按时长算，大约每 2.5–3 秒一个动作（推门出来、蹲下看车底各算一个），一镜最多三个；动作之间写停顿和反应。开头画面里已经在的东西写成已经在那儿，不写成现铺、现拿。';
const H3_RULES = numbered([H3_SECTIONS, H3_TAGS, H3_DIALOGUE, H3_ANCHORS, '镜头按“起点 → 唯一动作 → 终点”写，保持原有时长与边界，不添加下一镜或镜外转换。', H3_PACE, H3_SOUND], 2);

const SHARED_RULES = `硬性规则：
1. 只输出 JSON：{"prompt":"完整提示词"}，不要 Markdown、解释或代码块。
${H3_RULES}`;

// How a one-line, everyday remark ("让男主稍微帅一点") becomes a precise edit. Shared by the video prompt and the
// picture wish; each adds its own examples, written in the language that prompt is written in.
const PLAIN_TALK = `怎么理解用户的话：
- 用户说的是随口的大白话，可能很短、很口语、指代模糊，比如「男主」「女主」「她」「那个骑车的」「背景」。先弄清它指的是哪个人物或画面的哪一部分：按人名、角色称呼、性别、参考图文件名里的代号和名字去对应。实在对应不上，就改画面里最主要的人物。
- 把主观感受翻译成画面上看得见的具体描写，写进提示词，不要原样照抄用户的话。「好看」「帅」「丑」「显老」「吓人」这类词本身对模型没用，要换成五官、皮肤、发型、体态、神情、光线、景别这些具体说法。
- 按程度词控制改动幅度：「稍微」「一点」「有点」只做轻微调整，加一两处描写或换一两个词；「很」「特别」「完全」才做明显改动。
- 只改用户说的那件事，以及为了它必须跟着改的地方：同一个人物在别处的描写要一起改，前后不能矛盾。没提到的人物、动作、剧情、机位、台词和声音保持原样。
- 改外形时不改掉人物身份：年龄、性别、民族、发型、服装和标志性特征保持不变，除非用户明确要求改它们。原描写里和用户意见冲突的词（比如要变帅，原文却写着憔悴、浮肿、胡子拉碴）要改掉或减弱，不能留着互相打架。
- 用户也可能说的是整体意见，比如「太暗了」「太假了」「节奏太慢」「不够像纪录片」，那就改对应的光线、质感、节奏或摄影描写。`;

const VIDEO_EXAMPLES = `例子（写进提示词时用英文）：
- 「让男主稍微帅一点」→ 只在男主的描写里补一两处：well-defined features, clear bright eyes, a clean jawline, neat hair，或把讨好脸的柔和侧光写进去；把 haggard、puffy 这类和它冲突的词换掉。
- 「她太淡定了」→ 在她原有的节拍里加重害怕：呼吸变急、手发抖、目光躲闪，不加新节拍。
- 「画面太亮」→ 把原来的光线描写换成更暗的：dim ambient light, deep shadows，光源方向不变。
- 「车灯晃到镜头了」→ 把写车灯的那句改成光的去向：the headlight beam stays low on the wet road ahead；不写 no glare、no lens flare。
- 「车动得太早」→ 把起步那一拍往后挪，前面几拍写清车停着的样子：both boots planted on the asphalt, the front wheel still；不写 the bicycle does not move。
- 「还是往前骑了」（原文里已经有 the bicycle does not move，或 he never pedals）→ 说的是同一件事，上次没改好。找出是哪里把动作带回来的：某一拍写了 rolling、pushing off，或者接续开头本来就在动。把那一拍改成停住的具体样子（brakes hard within the first second, both feet down, the bike locked in place），再删掉原来那句否定；不写 does not move an inch、never ever。`;

// How the edit is made. Video models attend to the nouns they read, so new text says what is there, not what isn't;
// a shot may hold several beats, and only the one the remark is about changes.
const VIDEO_EDITING = `怎么下笔：
- 写想要的样子，不写不想要的东西。视频模型读到「no lens flare」「the bicycle does not move」时会注意到 lens flare、moving，反而更容易拍出来。新写的句子不用 no、not、never、without、avoid 这类否定写法，也不点名要去掉的东西：删掉原文里写它的字；需要补一句时，写它现在是什么样。
- 原文里已有的否定句：和这次反馈说的是同一件事的，一并换成正面说法或删掉，它们正是改不好的原因之一；和这次反馈无关的原样保留。
- 用户反复说同一件事（原文里已经有针对它的句子，用户还在说），说明问题不在措辞不够狠，而在画面里还有东西把它带回来：某一拍的动作、接续开头带进来的惯性、参考图。改那里，不叠加更重的否定（「一寸都不」「绝对不」「完全不」「始终不」）。
- 保持原有的动作节拍和顺序。一个镜头可以有好几个节拍，用户说的是哪一拍就只改哪一拍，其余节拍不增、不删、不合并；镜头停在原来的终点，不写下一镜的事。用户要求放慢、删动作时例外，按用户说的删。
- 要加新动作时先看时长：加了以后超过每 2.5–3 秒一个动作，就把次要的动作删掉，不要压缩着写。
- 原文里的时间点（At 00:03.500、by approximately 00:06.400）跟着改动的节拍调整，最后一个时间点不超过当前时长。`;

// A continued shot opens on the last frames of the previous one (they overlap and are cut), so its opening stays put.
const CONTINUATION = `接续的镜头（请求里写着「接续上一镜：是」时才适用）：开头约 1 秒和上一镜的结尾重叠，剪辑时会剪掉，画面必须从上一镜最后的状态接着走。
- [Shot 1] 开头交代的起始状态（机位、景别、人物位置和姿态、光线）原样保留，不重新建立场景，不在开头写转场或切镜。
- 用户的意见落在后面的节拍上。如果用户要改的就是开头，只改到还能和上一镜接上的程度，并在 note 里提醒用户上一镜的结尾也要对得上。
- 原文里「Continuing …」「from the previous moment」这类接续写法保留。`;

function contextText(context = {}) {
  const references = Array.isArray(context.references) ? context.references : [];
  const lines = [`参考图数量：${references.length}`, `时长：${context.duration ?? '未指定'} 秒`];
  if (context.width && context.height) lines.push(`实际分辨率：${context.width} × ${context.height}`);
  if (typeof context.continuation === 'boolean') lines.push(`接续上一镜：${context.continuation ? '是' : '否'}`);
  if (references.length) {
    lines.push('参考图顺序：');
    references.forEach((value, index) => lines.push(`<Picture ${index + 1}> = ${value}`));
  } else {
    lines.push('这一镜不挂参考图。');
  }
  if (typeof context.blocking === 'string' && context.blocking.trim()) lines.push('', context.blocking.trim());
  return lines.join('\n');
}

const OPTIMIZERS = {
  refine: {
    label: '润色',
    task: '润色用户已有的 MiniMax H3 提示词，提高可生成性和动作、表演、摄影、声音的清晰度。保留原剧情、人物、镜头边界、时长和参考图编号，不重写成别的格式。',
    temperature: 0.2,
  },
  expand: {
    label: '扩写',
    task: '把用户给出的简短想法扩写成可直接用于 MiniMax H3 的完整提示词。需要具体、可拍摄、可生成，但不要发明与用户设定冲突的人物或剧情。',
    temperature: 0.5,
  },
};

const FOCUS_RULES = {
  concise: '精简与去冗余：删除重复、空泛形容词和互相矛盾的描述，但不要删除关键视觉事实、身份锚点、动作边界和必要声音信息。',
  repair: '结构校验：补齐或纠正六段顺序、未定义标签、错误的 Picture/Subject 编号、缺失的声音层和互相冲突的字段。',
  performance: '动作与表演：按因果和物理顺序写清身体朝向、目光、双手、持物、接触与落点，一个镜头只保留一个主动作，避免堆叠过多表情节拍。',
  camera: '运镜与光线：运镜必须有动机，写清起止构图、速度和终点；光向、时段与参考图保持连续，避免无意义炫技和互相矛盾的镜头调度。',
  continuity: '参考图与连续性：核对 Picture/Subject 编号、素材用途、身份/地理/起始帧锚点及 must_not_control，避免角色板控制构图、场景板控制人物，以及跨镜造型和状态漂移。',
  audio: '对白与声音：逐字保留中文台词和稳定说话人 ID，检查台词是否能容纳于当前时长，写清开口 cue、停顿、声源、环境声和配乐空层，不添加未授权新台词。',
};

// Room for the reply: a whole video prompt runs to a few thousand tokens, and a thinking model spends as many again
// before it writes, so 4096 cut rewrites off halfway ("提示词不完整").
const REPLY_TOKENS = 16384;

// Prompt caching: the service reuses what it already read when a request starts with the same text, so every
// system prompt here is fixed text, the same byte for byte on every call of its kind. Rules that apply to some calls
// only (a task, a focus, a continued shot, the shots around it) are in the system prompt too, each saying when it
// applies, and the user message only names which ones do: in the user message they would be read uncached every
// time. What changes from call to call (the shot itself, the user's words) goes in the user message.
const focusLabel = (rule) => rule.split('：')[0];
const OPTIMIZER_SYSTEM = `你是 MiniMax H3 视频提示词编辑。按请求开头写的任务和优化重点处理用户给的提示词或想法。

任务（请求开头写的是哪一个就只做哪一个）：
${Object.values(OPTIMIZERS).map((o) => `- ${o.label}：${o.task}`).join('\n')}

优化重点（只做请求里列出的那几项，列出的不要遗漏；请求里没列就只按任务处理）：
${Object.values(FOCUS_RULES).map((rule) => `- ${rule}`).join('\n')}

${SHARED_RULES}`;

function buildOptimizerMessages({ optimizer, text, context, focus }) {
  const spec = OPTIMIZERS[optimizer] || OPTIMIZERS.refine;
  const selected = Array.isArray(focus) ? focus : Object.keys(FOCUS_RULES);
  const labels = [...new Set(selected.map((id) => FOCUS_RULES[id]).filter(Boolean).map(focusLabel))];
  const focusText = labels.length ? `\n本次优化重点：${labels.join('、')}` : '';
  const user = `任务：${spec.label}${focusText}\n\n${contextText(context)}\n\n用户原始提示词或想法：\n${text}\n\n请按系统要求输出 JSON。`;
  return { system: OPTIMIZER_SYSTEM, user, temperature: spec.temperature, maxTokens: REPLY_TOKENS };
}

// The reply is tagged text, not JSON: a prompt of several thousand characters breaks JSON as soon as one newline
// or quote is left unescaped.
// How a rewrite keeps the shots around it joined up (given when the request shows them).
const NEIGHBOURS = `前后镜头要接得上（请求里给出了前后镜头时才适用）：请求里给出了上一镜和后面镜头的节拍，只用来对照，不改它们。
- 尽量不动后面镜头要接的东西：这一镜结尾的人物位置、姿态、机位、光线和道具状态，以及前面镜头已经交代过的事实（谁在场、穿什么、拿着什么）。
- 用户的要求非改到它们不可时，照用户的意思改，然后在 <affects> 里列出必须跟着改的镜头：每行一个，「镜头编号 | 一句原因 | 给那一镜的修改说明」。修改说明用用户的口吻写成一句大白话，说清那一镜要改成什么样（比如「开头他已经停稳、双脚着地，从停住的状态开始」），写正面的样子。
- 只列真的会对不上的镜头；都接得上就输出空的 <affects></affects>。`;

const AFFECTS_FORMAT = '<affects>\n镜头编号 | 原因 | 给那一镜的修改说明\n</affects>';

// The same for every shot rewrite (the first pass, the tidy pass, the pace pass, linked and blocking rewrites); the
// rules for a continued shot and for the shots around it are in it too, each saying when it applies.
const REVISION_SYSTEM = `你是 MiniMax H3 视频提示词编辑。用户已经看过当前生成的结果，用一句大白话说出想怎么改。反馈是本次修改的首要依据：把这句话当成编辑指令，直接在原提示词上改。要去掉的，删掉写它的字；要换的，把原来的描写替换成新的样子。只改落实它必须改的那几处，其余句子逐字保留，不改写、不调换顺序、不顺手润色，也不借机添加新剧情；镜头边界、时长和参考图编号保持稳定。\n\n${PLAIN_TALK}\n\n${VIDEO_EDITING}\n\n${VIDEO_EXAMPLES}\n\n${CONTINUATION}\n\n${NEIGHBOURS}\n\n硬性规则：
1. 只按下面的格式输出，不要 Markdown、代码块或其他解释：
<note>一句中文，告诉用户具体改了哪里</note>
<prompt>
修订后的完整提示词
</prompt>
请求里给出了前后镜头时，在 </prompt> 后面接着输出：
${AFFECTS_FORMAT}
${numbered([H3_SECTIONS, H3_TAGS, H3_DIALOGUE, H3_ANCHORS, '保持原有时长、镜头边界和动作节拍，不添加下一镜或镜外转换。', H3_SOUND,
    '用户明确要求改某句台词时，照用户的意思只改那一句，其余台词逐字保留。'], 2)}`;

// Stable before changing: what the shot is and the shots around it come first (the same on every pass and every
// rewrite of this shot, so they are cached too), then the prompt, then the remark.
function buildRevisionMessages({ text, feedback, context = {}, neighbours = '' }) {
  const user = [
    contextText(context),
    ...(neighbours ? [neighbours] : []),
    `当前完整提示词：\n${text}`,
    `用户的原话：\n${feedback}`,
    neighbours ? '请按格式输出 <note>、<prompt>，再输出 <affects>。' : '请按格式输出 <note> 和 <prompt>，这次不输出 <affects>。',
  ].join('\n\n');
  return { system: REVISION_SYSTEM, user, temperature: 0.3, maxTokens: REPLY_TOKENS };
}

const dialogueOf = (text) => [...String(text).matchAll(/<d>([\s\S]*?)<\/d>/g)].map((m) => m[1].trim());
const sectionsOf = (text) => [...String(text).matchAll(new RegExp(`^\\s*(${SECTIONS.join('|')})\\s*[:：]`, 'gm'))].map((m) => m[1]);
const numbersOf = (text, tag) => [...String(text).matchAll(new RegExp(`<${tag} (\\d+)>`, 'g'))].map((m) => Number(m[1]));

// What the code can check after a rewrite. `refuse` means the result must not be used (the six sections broke);
// the warnings are shown to the user next to the note.
function checkRevision({ before, after, references = [] }) {
  const warnings = [];
  const complete = (text) => sectionsOf(text).join() === SECTIONS.join();
  if (complete(before) && !complete(after)) return { refuse: '改写结果的六段结构不完整或顺序变了，没有采用，请再试一次', warnings };
  const was = dialogueOf(before);
  const now = dialogueOf(after);
  if (was.join('\n') !== now.join('\n')) {
    const changed = now.find((line, index) => line !== was[index]) || '（删了台词）';
    warnings.push(`台词有改动（原来 ${was.length} 句，现在 ${now.length} 句），比如「${changed.replace(/^\[Chinese\]\s*/, '')}」，请确认是你要改的`);
  }
  const extra = [...new Set(numbersOf(after, 'Picture').filter((n) => n > references.length))];
  if (extra.length) warnings.push(`提示词里有 ${extra.map((n) => `<Picture ${n}>`).join('、')}，但这一镜只挂了 ${references.length} 张参考图`);
  const defined = new Set([...String(after).matchAll(/^\s*<Subject (\d+)>\s+is\b/gm)].map((m) => Number(m[1])));
  const undefinedSubjects = [...new Set(numbersOf(after, 'Subject'))].filter((n) => !defined.has(n));
  if (defined.size && undefinedSubjects.length) warnings.push(`${undefinedSubjects.map((n) => `<Subject ${n}>`).join('、')} 在 subject_definitions 里没有定义`);
  return { refuse: '', warnings };
}

// A card's picture is style + appearance + wish. A remark about the pictures is an edit to the last two: the
// appearance is the card's own copy of the list's line (the list stays as written), the wish is the user's.
// Image models draw the nouns they read, so the edit deletes or replaces words instead of adding "不要……".
// How a card rewrite keeps the shots that show it in line (given when the request lists them).
const CARD_USERS = `用到这张卡的镜头（请求里列出了它们时才适用）：镜头里也写着它的样子。外形描述改了以后，哪个镜头里还写着旧样子（比如镜头里写着耳后夹着烟，外形里已经删掉了烟），就在 affects 里列出它：shot 照抄镜头编号，reason 写一句原因，remark 用用户的口吻写一句给那一镜的修改说明，写成正面的样子（比如「老周耳朵干净，肩上搭着旧毛巾，把镜头里写烟的地方删掉」）。镜头里没写到改动的那部分就不列；没有就输出空数组。`;

const I2I_RULE = '图生图（请求里写着「出图方式：图生图」时才适用）：基于卡里已有的一张图改。外形描述里改了的地方，在「想要什么样的图」里也用正面说法写清楚改成什么样（比如「腰间只挂一把工具钳」）；其余和原图保持一样，人物还是同一个人。';
const AFFECTS_JSON = '{"look":"…","ask":"…","note":"…","affects":[{"shot":"镜头编号","reason":"原因","remark":"给那一镜的修改说明"}]}';

// The same for every card and both ways of making the picture; the rules for picture-to-picture and for the shots
// that show the card are in it too, each saying when it applies.
const PICTURE_SYSTEM = `你是 Qwen-Image 出图提示词编辑。一张素材卡的出图提示词由三段拼成：画风（固定，你不能改）、外形描述（这个人物或场景长什么样）、「想要什么样的图」（这一张图的构图、景别、姿势、光线、背景）。用户看过出来的图，用一句大白话说出想怎么改。

把用户的话当成编辑指令，直接改原文：要去掉的东西，删掉写它的那几个字；要换掉的，把原来的描写替换成新的样子。改完的提示词要读起来像一开始就是这么写的，而不是在后面追加一条修改意见。

${PLAIN_TALK}

怎么下笔：
- 东西写在哪一段就改哪一段：长相、身材、发型、服装、随身物件、标志在外形描述里改；构图、景别、姿势、光线、背景在「想要什么样的图」里改。两段不重复写同一件事。
- 只动和用户的话有关的那几处，其余句子逐字保留，不改写、不调换顺序、不顺手润色。
- 写想要的样子，不写不想要的东西。图像模型读到「不要挂钥匙」「没有胡子」「避免裁切」时只会注意到「钥匙」「胡子」「裁切」，反而更容易画出来。所以不写「不要」「没有」「别」「避免」「不再」「去掉」这类否定句，也不点名要去掉的东西：删掉原文里写它的字；需要补一句时，写它现在是什么样。实在找不到正面说法时才用否定，并且只写一次。
- 顺手收拾原文里已有的否定写法（下面会列出来）：意思不变地换成正面说法（「不胖也不矮」→「身材匀称」，「不化浓妆」→「淡妆」）；它说的东西如果就是要去掉的，连同别处写它的字一起删掉。这只换说法，不改画面，不算顺手润色。
- 用户又说了一遍以前说过的事（比如「想要什么样的图」里已经写着不夹烟，用户还在说烟），说明还有地方在写它：去外形描述里找到写它的字删掉，再把那句否定也删掉。不要换一种更重的说法再说一遍。
- 两段只描述最终的画面，读起来像一开始就是这么写的：不出现修改口吻（「改成」「不再」「照旧」「还是」「收一点」「清楚可见」）和对画师说的话。
- 「想要什么样的图」只写这张图的构图、景别、姿势、表情、光线、背景。长相、身材、发型、服装、随身物件只在外形描述里写一次；「想要什么样的图」里已经有的，删掉重复的那份，外形描述里没有的挪过去。
- 不添加和用户的话无关的新要求或限制。

例子：
- 外形描述写着「标志：腰间挂一串酒店的车钥匙和一把多功能工具钳」，用户说「腰间不要挂钥匙」→ 外形描述里这句改成「标志：腰间挂一把多功能工具钳」，其余一字不动；不写「腰间没有钥匙」。
- 「把墨镜摘了」→ 删掉外形描述里写墨镜的那几个字；如果原文写着「眼睛藏在墨镜后」，改成「眼神沉静」这类看得见的样子。
- 「脸太红了」（外形描述写着「脸颊被高原的风吹得通红」）→ 改成「脸颊带一点淡淡的高原红」。
- 「让他稍微帅一点」→ 在外形描述里把和它冲突的词换掉（憔悴→精神），补一两处：眉眼有神，下颌线清楚。
- 「太亮了」→ 把「想要什么样的图」里原来的光线描写换成：整体偏暗，只有局部光，阴影深。不写「不要太亮」。
- 「脚被裁掉了」→ 景别改成：全身，从头到脚完整入画，脚下留出一截地面。
- 外形描述写着「标志：肩上搭一条旧毛巾，一根没点的烟横着夹在耳后」，「想要什么样的图」写着「耳后不夹香烟，耳朵干净，没有烟」，用户说「还是有烟」→ 外形描述改成「标志：肩上搭一条旧毛巾」，「想要什么样的图」删掉那句否定，两段里写烟的字都删干净。

${I2I_RULE}

${CARD_USERS}

硬性规则：
1. 只输出 JSON：{"look":"改后的外形描述","ask":"改后的「想要什么样的图」","note":"一句中文，告诉用户具体改了哪里"}，不要 Markdown、解释或代码块。请求里列出了用到这张卡的镜头时，同一个 JSON 里再加上 affects：${AFFECTS_JSON}。两段都要完整输出，没改的那段原样照抄；原来是空的就输出空字符串。
2. 用中文写，短句加逗号，写画面上看得见的东西；「想要什么样的图」不超过 300 字。
3. 外形描述里年龄、性别、身份和用户没提到的标志保持原样。
4. 不写画面里的文字、字幕、水印，出图时会自动加上。`;

function buildPictureRevisionMessages({ card = {}, mode, ask, look, feedback, usage = '' }) {
  const i2i = mode === 'i2i';
  const appearance = typeof look === 'string' ? look : card.description || '';
  // the card first: the same on both passes of a rewrite, so the second one reads it from the cache
  const user = [
    `素材卡：${card.name || '（无名）'}（${card.kind === 'scene' ? '场景' : '人物'}）`,
    `出图方式：${i2i ? '图生图' : '文生图'}`,
    `画风（固定）：${card.style || '（无）'}`,
    ...(usage ? ['', usage, ''] : []),
    `现在的外形描述：${appearance || '（空）'}`,
    `现在的「想要什么样的图」：${ask || '（空）'}`,
    `两段里现有的否定写法：${[...negations(appearance), ...negations(ask)].join('；') || '（没有）'}`,
    '',
    `用户的原话：\n${feedback}`,
    '',
    usage ? '请输出 JSON，带上 affects。' : '请输出 JSON。',
  ].join('\n');
  return { system: PICTURE_SYSTEM, user, temperature: 0.3, maxTokens: REPLY_TOKENS };
}

// A new shot written from the user's few words: the prompt, and the title, length, cards and continuation the
// software then sets on the shot. The reply is tagged text with a small JSON for the settings.
const COMPOSE_SYSTEM = `你是 MiniMax H3 视频提示词编剧。用户要在一集里新加一个镜头，用大白话说了想拍什么。你写出这一镜完整的 H3 提示词，并定下它的标题、时长、参考图和是否接着上一镜。

怎么写：
- 照用户说的拍，不加用户没说的剧情、人物和台词。用户没给台词就不写台词；给了的台词逐字照抄。
- 人物和地点从请求里的「素材卡」里挑：画面里出现的每个人挂他的人物卡，地点挂一张场景卡，只挂这一镜画面里真的有的。素材卡里没有的人或地方用文字描写，不挂图。
- references 的顺序就是 <Picture N> 的编号：第一个代号是 <Picture 1>。subject_definitions 里每张参考图都有一条 <Subject k> 指向它的 <Picture N>：人物卡写成那个人，场景卡写成地点，不要把场景图写成人。每张挂上的图在提示词里都要用到。
- 请求里给了上一镜时，照它的格式、画风、语言和人物外形写，同一集要像同一部剧；人物穿什么、拿着什么、在哪儿，接着上一镜的事实写。
- 接续：用户说接着上一镜拍，或这一镜就是上一镜同一机位、同一时刻接着发生的动作，continue 写 true，画面从上一镜结尾的状态开始，[Shot 1] 开头写清那个状态，summary 用 Continuing … 开头。换了机位、换了场面或跳了时间，写 false。请求里没有上一镜时只能写 false。
- 请求里给了下一镜时，这一镜的结尾要能接上它，不和它矛盾。
- 时长按动作算：大约每 2.5–3 秒一个动作，一般 4–10 秒，最长 15 秒。
- 写想要的样子，不写不想要的东西：不用 no、not、never、without、avoid 这类否定写法，也不点名不想出现的东西。
- 画面上没有字幕、文字和水印。

硬性规则：
1. 只按下面的格式输出，不要 Markdown、代码块或其他解释：
<note>一句中文，告诉用户这一镜怎么拍的</note>
<meta>{"title":"十个字以内的中文标题","duration":秒数,"references":["素材卡代号"],"continue":false}</meta>
<prompt>
完整提示词
</prompt>
${numbered([H3_SECTIONS, H3_TAGS, H3_DIALOGUE, H3_ANCHORS, '镜头按“起点 → 动作 → 终点”写，停在这一镜的终点，不写下一镜的事或镜外转换。', H3_PACE, H3_SOUND], 2)}`;

const clipText = (text, max) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

// cards: [{ code, kind, name, description, main }] (only the ones with a picture can be hung on the shot)
// previous / next: { id, prompt } of the shots the new one sits between, when there are any
function buildComposeMessages({ cards = [], previous = null, next = null, maxReferences = 6, title = '', description }) {
  const usable = cards.filter((c) => c.main);
  const user = [
    usable.length
      ? `素材卡（代号 | 类型 | 名字 | 外形）：\n${usable.map((c) => `- ${c.code} | ${c.kind === 'scene' ? '场景' : '人物'} | ${c.name} | ${clipText(c.description, 160) || '（没写）'}`).join('\n')}`
      : '素材卡：没有带图的卡，这一镜不挂参考图（references 写空数组，提示词里不写 <Picture N>）。',
    previous ? `上一镜 ${previous.id}（完整提示词，照它的格式和画风写）：\n${previous.prompt || '（还没有提示词）'}` : '这一镜前面没有镜头：它是本集第一镜。',
    next ? `下一镜 ${next.id}（这一镜的结尾要能接上它）：\n${clipText(next.prompt, 1800) || '（还没有提示词）'}` : '',
    `最多挂 ${maxReferences} 张参考图。`,
    title ? `用户起的标题：${title}` : '',
    `用户想拍的：\n${description}`,
    '请按格式输出 <note>、<meta> 和 <prompt>。',
  ].filter(Boolean).join('\n\n');
  return { system: COMPOSE_SYSTEM, user, temperature: 0.5, maxTokens: REPLY_TOKENS };
}

// → { note, meta: { title, duration, references, continue }, prompt }; throws what is wrong with the reply
function parseCompose(text) {
  const raw = String(text || '');
  const start = raw.indexOf('<prompt>');
  if (start < 0) throw new Error('没有 <prompt>');
  const end = raw.lastIndexOf('</prompt>');
  if (end < start) throw new Error('<prompt> 没有写完（可能被截断了）');
  const prompt = raw.slice(start + '<prompt>'.length, end).trim();
  if (!prompt) throw new Error('<prompt> 是空的');
  const metaText = /<meta>([\s\S]*?)<\/meta>/.exec(raw);
  if (!metaText) throw new Error('没有 <meta>');
  let meta;
  try {
    meta = parseJsonReply(metaText[1]);
  } catch {
    throw new Error('<meta> 里不是 JSON');
  }
  const note = /<note>([\s\S]*?)<\/note>/.exec(raw.slice(0, start));
  return { note: note ? note[1].trim() : '', meta, prompt };
}

function parseJsonReply(text) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('LLM 返回内容不是 JSON');
  return JSON.parse(trimmed.slice(start, end + 1)) || {};
}

const noteOf = (data) => (typeof data.note === 'string' ? data.note.trim() : '');

function parseOptimizedText(text) {
  const data = parseJsonReply(text);
  if (typeof data.prompt !== 'string' || !data.prompt.trim()) throw new Error('LLM 返回的 JSON 缺少 prompt');
  return data.prompt.trim();
}

// <note>…</note><prompt>…</prompt>; the older JSON reply is still read. A <prompt> that never closes was cut off.
function parseRevision(text) {
  const raw = String(text || '');
  const start = raw.indexOf('<prompt>');
  if (start < 0) return { prompt: parseOptimizedText(raw), note: noteOf(parseJsonReply(raw)) };
  const end = raw.lastIndexOf('</prompt>');
  if (end < start) throw new Error('LLM 返回的提示词不完整（可能被截断了），请再试一次');
  const prompt = raw.slice(start + '<prompt>'.length, end).trim();
  if (!prompt) throw new Error('LLM 返回的提示词是空的');
  const note = /<note>([\s\S]*?)<\/note>/.exec(raw.slice(0, start));
  return { prompt, note: note ? note[1].trim() : '' };
}

// The wish may be empty when only the appearance changed; a reply without a look leaves the look alone.
function parsePictureRevision(text) {
  const data = parseJsonReply(text);
  const look = typeof data.look === 'string' ? data.look.trim() : undefined;
  if (typeof data.ask !== 'string' || (!data.ask.trim() && !look)) throw new Error('LLM 返回的 JSON 缺少 ask');
  return { ask: data.ask.trim(), ...(look !== undefined ? { look } : {}), note: noteOf(data), ...(Array.isArray(data.affects) ? { affects: data.affects } : {}) };
}

module.exports = {
  buildOptimizerMessages, buildRevisionMessages, buildPictureRevisionMessages, buildComposeMessages,
  parseOptimizedText, parseRevision, parsePictureRevision, parseCompose, checkRevision, contextText, OPTIMIZERS, FOCUS_RULES, SECTIONS,
};
