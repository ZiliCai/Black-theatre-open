// Built-in knowledge about the user's models. Each rule: match (regex on the lower-cased path), optional
// categories, family, tags, title, desc. Titles/descriptions may be functions of the regex match.
// Only things we actually know go in here (from the user's own workflow notes and what was downloaded
// during setup); everything else falls back to guessing and is labelled "推测" in the UI.
//
// To teach the launcher a new model, add a rule near the top. The first matching rule wins.

const step = (m) => Number(m[2]);

const RULES = [
  // ---------------- MiniMax H3 main models ----------------
  {
    match: /minimax[-_]?h3[-_]ref2va/,
    family: 'MiniMax H3',
    tags: ['视频生成', '参考图', '带音频'],
    title: 'H3 参考图转视频(Ref2VA)',
    desc: '用参考图(最多 4 张)生成带声音的视频,是你「模式 C」生成视频的主模型。',
  },
  {
    match: /minimax[-_]?h3[-_]fl2va/,
    family: 'MiniMax H3',
    tags: ['视频生成', '首尾帧', '带音频'],
    title: 'H3 首尾帧转视频(FL2VA)',
    desc: '给定首帧和尾帧,生成中间带声音的视频。',
  },

  // ---------------- MiniMax H3 LoRAs ----------------
  {
    match: /minimax_h3_(fl2v|ref2v)_turbo_(\d+)step/,
    family: 'MiniMax H3',
    tags: ['加速', 'LoRA'],
    tagsFn: (m) => [m[1] === 'fl2v' ? '首尾帧' : '参考图'],
    title: (m) => `H3 Turbo 加速 LoRA(${step(m)} 步)`,
    desc: (m, name) =>
      `把采样步数压到 ${step(m)} 步,明显缩短出片时间;用于${m[1] === 'fl2v' ? '首尾帧(FL2V)' : '参考图(Ref2V)'}模式。` +
      (/768p/.test(name) ? '这是针对 768p 分辨率的版本。' : '') +
      (/v0\.1/.test(name) ? '版本号 v0.1,属于早期版本,效果可能不稳定。' : ''),
  },
  {
    match: /minimax_h3_turbo_v4/,
    family: 'MiniMax H3',
    tags: ['加速', 'LoRA'],
    title: 'H3 Turbo v4 加速 LoRA',
    desc: (m, name) =>
      '你的 Ref2VA 流程默认搭配的加速 LoRA,8 步出片。' + (/pruned/.test(name) ? '这是精简体积的 pruned 版本。' : ''),
  },
  {
    match: /h3-realism-people/,
    family: 'MiniMax H3',
    tags: ['写实', 'LoRA'],
    title: 'H3 真人写实 LoRA',
    desc: '改善真人的皮肤质感(去油),适用于文生视频、图生视频和参考图生视频。',
  },

  // ---------------- Qwen-Image family ----------------
  {
    match: /qwen_image_2\.1_(int8|bf16|fp8)/,
    family: 'Qwen-Image 2.1',
    tags: ['图像生成', '图像编辑'],
    title: 'Qwen-Image 2.1 图像模型',
    desc: 'Qwen-Image 2.1 官方版(Comfy-Org 发布),素材页的文生图和参考图改图都用它。',
  },
  {
    match: /qwen-image-2\.1-uc/,
    family: 'Qwen-Image 2.1',
    tags: ['图像生成'],
    title: 'Qwen-Image 2.1 量化版(UC)',
    desc: 'Qwen-Image 2.1 的 GGUF 量化版,文件名带 UC 标记。体积小,显存紧张时可以用它。',
  },
  {
    match: /qwen_image_2\.1_turbo/,
    family: 'Qwen-Image 2.1',
    tags: ['图像生成', '加速'],
    title: 'Qwen-Image 2.1 Turbo',
    desc: '少步数出图的 Turbo 版,社区制作的 GGUF 转换(Q8_0,接近无损)。需要用 UnetLoaderGGUF 加载;采样步数和 CFG 请参考原仓库说明,不要照搬基础版的设置。',
  },

  // ---------------- Wan 2.2 ----------------
  {
    match: /umt5_xxl/,
    family: 'Wan 2.2',
    tags: ['文本编码'],
    title: 'UMT5-XXL 文本编码器',
    desc: 'Wan 系列视频模型使用的文本编码器(fp8 缩放版)。',
  },
  {
    match: /wan_2\.1_vae/,
    family: 'Wan 2.2',
    tags: ['VAE'],
    title: 'Wan VAE',
    desc: 'Wan 2.1 / 2.2(A14B)视频模型共用的 VAE,负责把生成结果解码成画面。',
  },

  // ---------------- text encoders ----------------
  {
    match: /qwen3vl_32b_minimax_h3/,
    family: 'MiniMax H3',
    tags: ['文本编码'],
    title: 'H3 文本编码器(Qwen3-VL 32B)',
    desc: (m, name) =>
      'H3 视频模型的文本编码器,能同时理解文字和参考图。' +
      (/nvfp4/.test(name) ? 'NVFP4 版本,只有 RTX 50 系显卡才有硬件加速。' : '') +
      (/\.gguf$/.test(name) ? 'GGUF 量化版,体积最小。' : '') +
      (/int8/.test(name) ? 'INT8 版本。' : ''),
  },
  {
    match: /qwen3vl_8b/,
    family: 'Qwen-Image 2.1',
    tags: ['文本编码'],
    title: 'Qwen3-VL 8B 文本编码器',
    desc: 'Qwen-Image 系列使用的文本编码器。',
  },

  // ---------------- VAEs ----------------
  {
    match: /minimax_h3_video_vae/,
    family: 'MiniMax H3',
    tags: ['VAE'],
    title: 'H3 视频 VAE',
    desc: 'H3 的视频 VAE,把生成的潜空间解码成视频画面。',
  },
  {
    match: /minimax_h3_audio_vae/,
    family: 'MiniMax H3',
    tags: ['VAE'],
    title: 'H3 音频 VAE',
    desc: 'H3 的音频 VAE,用来生成视频里的声音。',
  },
  {
    match: /minimax_h3_vae_(encoder|decoder)\.engine/,
    family: 'MiniMax H3',
    tags: ['VAE'],
    title: (m) => `H3 视频 VAE ${m[1] === 'decoder' ? '解码' : '编码'}器(TensorRT)`,
    desc: 'TensorRT 加速引擎,让 VAE 处理更快。与显卡型号和 TensorRT 版本绑定,换显卡后需要重新生成。',
  },
  {
    match: /minimax_h3_vae_(encoder|decoder)\.onnx/,
    family: 'MiniMax H3',
    tags: ['VAE'],
    title: (m) => `H3 视频 VAE ${m[1] === 'decoder' ? '解码' : '编码'}器(ONNX 源文件)`,
    desc: 'TensorRT 引擎的来源文件(ONNX),用来在本机重新生成 TensorRT 引擎。',
  },
  {
    match: /qwen_image_2\.1_vae/,
    family: 'Qwen-Image 2.1',
    tags: ['VAE'],
    title: 'Qwen-Image 2.1 VAE',
    desc: 'Qwen-Image 2.1 的 VAE,负责把生成结果解码成图片。',
  },

  // ---------------- live-preview decoders (models/vae_approx) ----------------
  {
    match: /taeh3/,
    family: 'MiniMax H3',
    tags: ['VAE', '实时预览'],
    title: 'H3 实时预览解码器(TAEH3)',
    desc: '采样过程中显示实时预览画面用的小型解码器,你的「实时预览」节点正在使用它。只影响预览,不影响最终画质。',
  },
  {
    match: /(taesdxl|taesd|taef1)_(encoder|decoder)/,
    tags: ['VAE', '实时预览'],
    familyFn: () => '',
    title: (m) =>
      `TAESD 实时预览${m[2] === 'decoder' ? '解码' : '编码'}器(${{ taesd: 'SD', taesdxl: 'SDXL', taef1: 'Flux' }[m[1]]})`,
    desc: '采样时实时预览用的小型解码器(TAESD 系列),体积很小。只影响预览画面,不影响最终画质。',
  },

  // ---------------- language models (prompt optimisation) ----------------
  {
    match: /mmproj/,
    familyFn: (name) => (/3\.5mmproj/.test(name) ? 'Qwen 3.5 LLM' : 'Qwen 3.8 LLM'),
    tags: ['多模态'],
    title: '视觉投影文件(mmproj)',
    desc: '让同系列大语言模型能“看图”的配套文件,单独使用没有意义。',
  },
  {
    match: /qwen3\.8-27b/,
    family: 'Qwen 3.8 LLM',
    tags: ['大语言模型'],
    title: 'Qwen3.8 27B(量化版)',
    desc: '通用大语言模型。Q3 / Q4 / Q5 是量化档位,数字越大越精确,也越占内存。',
  },
  {
    match: /qwen3\.5-4b/,
    family: 'Qwen 3.5 LLM',
    tags: ['大语言模型'],
    title: 'Qwen3.5 4B(小型)',
    desc: '小型大语言模型,速度快、占用少,能力比 27B 弱。',
  },

  // ---------------- upscaling ----------------
  {
    match: /seedvr2_ema_3b/,
    family: 'SeedVR2',
    tags: ['画质放大'],
    title: 'SeedVR2 3B 画质放大',
    desc: '视频 / 图像画质修复放大模型(SeedVR2),Q8_0 量化。',
  },
  {
    match: /seedvr2|ema_vae/,
    categories: ['SEEDVR2'],
    family: 'SeedVR2',
    tags: ['VAE', '画质放大'],
    title: 'SeedVR2 VAE',
    desc: 'SeedVR2 放大模型配套的 VAE。',
  },
  {
    match: /minimax_h3_latent_upscaler/,
    family: 'MiniMax H3',
    tags: ['画质放大'],
    title: 'H3 潜空间放大模型',
    desc: '在潜空间里放大 H3 视频画面的放大模型(3D,fp16)。',
  },
];

module.exports = { RULES };
