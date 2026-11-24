// Everything the assets page does: the cards of the active script project (read from its people-and-places
// list), each card's draft, taking N more pictures, the tiers, the pictures kept in a card and its main picture.
// Plain Node, no Electron: the queue and the recycle bin are handed in.
const fs = require('node:fs');
const path = require('node:path');
const { listCards } = require('./asset-cards');
const { createAssetStore, CARD_CODE } = require('./asset-store');
const { buildPrompt } = require('./asset-prompt');
const { compileImage, familyOf } = require('./image-compile');
const { loadTemplate } = require('./workflow-template');
const { listScriptShots, imageCandidates, materialize } = require('./script-shots');
const { createTakeStore } = require('./take-store');
const { takeFiles } = require('./take-outputs');
const { resolveInside } = require('./safe-path');

const T2I = 'qwen-image-t2i';
const I2I = 'qwen-image-i2i';
const MAX_COUNT = 12;
const MAX_ASK = 2000;
const MAX_LABEL = 40;
const NO_PROJECT = { ok: false, noProject: true, message: '请先选择或新建一个剧本项目' };
const TIERS = new Set(['', 'cand', 'keep', 'trash']);
const OUTPUT_PICTURE = /^[^\\:*?"<>|]+\.(png|jpe?g|webp)$/i;

const working = (t) => t.status === 'queued' || t.status === 'running';
const defaultAspect = (kind) => (kind === 'scene' ? '16:9' : '3:4');
const asRef = (image) => `${image} [output]`;
// the first words of the wish, as a label a person can recognise the picture by
const labelOf = (ask) => String(ask || '').replace(/[，。,.!！?？；;：:\s]+/g, ' ').trim().slice(0, 12) || '参考图';
const cleanLabel = (label) => String(label || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);

function createAssetService({ getProject, templatesDir, queue, trash }) {
  const template = (id) => loadTemplate(path.join(templatesDir, id));

  // Cards from the list, plus cards that have records but are no longer listed.
  function collect(project) {
    const listed = listCards({ docsDir: project.docsDir });
    const store = createAssetStore(project.dir);
    const cards = [...listed.cards];
    const known = new Set(cards.map((c) => c.code));
    for (const code of store.listCodes()) {
      if (known.has(code)) continue;
      const read = store.readCard(code);
      cards.push({ code, kind: read.kind === 'scene' ? 'scene' : 'char', name: '清单里已没有', description: '', style: '', source: '', orphan: true });
    }
    return { store, cards, listed };
  }

  function find(project, code) {
    const all = collect(project);
    const card = all.cards.find((c) => c.code === code);
    return card ? { ...all, card } : null;
  }

  // Shots whose draft carries this picture as a reference.
  function shotsUsing(project, image) {
    const store = createTakeStore(project.dir);
    const value = asRef(image);
    return store.listShotIds().filter((id) => {
      const draft = store.readShot(id).draft;
      return !!(draft && draft.values && Array.isArray(draft.values.references) && draft.values.references.includes(value));
    });
  }

  // Script shots that name the card (IMG-<code>) among their references.
  function appearances(project, code) {
    const listed = listScriptShots({ docsDir: project.docsDir });
    return (listed.shots || [])
      .filter((s) => (s.references || []).some((r) => r.id.toUpperCase() === `IMG-${code}`))
      .map((s) => s.id);
  }

  // Pictures named after the card (QX_骑行者_全身.png) that are not kept in it yet: made before there were cards.
  function existingFor(project, code, kept) {
    const starts = new RegExp(`^${code.replace(/-/g, '\\-')}(?![A-Za-z0-9-])[\\s_·.-]*`, 'i');
    const seen = new Set(kept);
    const out = [];
    const candidates = [
      ...imageCandidates(project.outputDir, 'output'),
      ...imageCandidates(path.join(project.dir, 'ref'), 'ref'),
      ...imageCandidates(path.join(project.dir, 'input'), 'input'),
    ];
    for (const candidate of candidates) {
      const base = path.basename(candidate.relPath, path.extname(candidate.relPath));
      if (!starts.test(base) || /^bb_/i.test(base)) continue;
      const image = candidate.source === 'output' ? candidate.relPath : `ref/${candidate.name}`;
      if (seen.has(image)) continue;
      seen.add(image);
      out.push({ image, label: base.replace(starts, '') || base, source: candidate.source, relPath: candidate.relPath });
    }
    return out;
  }

  function draftOf(card, stored) {
    const d = stored || {};
    return {
      mode: d.mode === 'i2i' ? 'i2i' : 't2i',
      base: typeof d.base === 'string' ? d.base : '',
      ask: typeof d.ask === 'string' ? d.ask : '',
      aspect: typeof d.aspect === 'string' ? d.aspect : defaultAspect(card.kind),
      count: Number.isInteger(d.count) ? d.count : 1,
      // the card's own edit of the list's appearance line, and the line it was made from
      look: typeof d.look === 'string' ? d.look : '',
      lookFrom: typeof d.lookFrom === 'string' ? d.lookFrom : '',
    };
  }

  // The appearance the pictures use: the card's edit while the list still says what it was edited from.
  function lookOf(card, draft) {
    const edited = !!draft.look.trim() && draft.lookFrom === (card.description || '');
    return { text: edited ? draft.look : card.description || '', edited, stale: !!draft.look.trim() && !edited };
  }
  const promptOf = (card, draft) => buildPrompt({ mode: draft.mode, card, ask: draft.ask, look: lookOf(card, draft).text });

  // Removing a picture from the kept set moves the main picture on to the earliest kept one left.
  function withoutImage(read, image) {
    const set = read.set.filter((s) => s.image !== image);
    const main = read.main === image ? ((set[0] && set[0].image) || '') : read.main;
    return { set, main };
  }

  return {
    cards() {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const { store, cards, listed } = collect(project);
      if (!listed.ok) return listed;
      return {
        ok: true,
        warnings: listed.warnings,
        sources: listed.sources,
        message: listed.message,
        cards: cards.map((c) => {
          const read = store.readCard(c.code);
          return {
            code: c.code, kind: c.kind, name: c.name, orphan: !!c.orphan, main: read.main, kept: read.set.length,
            status: read.takes.some(working) ? 'busy' : read.main ? 'ready' : 'empty',
          };
        }),
      };
    },

    detail(code) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const found = find(project, String(code || ''));
      if (!found) return { ok: false, message: '找不到这张卡，请刷新' };
      const { store, card } = found;
      const read = store.readCard(card.code);
      const draft = draftOf(card, read.draft);
      const aspects = template(T2I).manifest.aspects.map(({ id, label, w, h }) => ({ id, label, w, h }));
      return {
        ok: true,
        card,
        draft,
        prompt: promptOf(card, draft),
        look: lookOf(card, draft),
        takes: read.takes,
        set: read.set.map((s) => ({ ...s, usedBy: shotsUsing(project, s.image) })),
        main: read.main,
        warning: read.warning,
        aspects,
        appearances: appearances(project, card.code),
        existing: existingFor(project, card.code, read.set.map((s) => s.image)),
      };
    },

    saveDraft(code, draft) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      if (!CARD_CODE.test(String(code))) return { ok: false, message: '代号不对，请刷新' };
      if (!draft || typeof draft !== 'object') return { ok: false, message: '出图设置格式不对' };
      const found = find(project, code);
      if (!found) return { ok: false, message: '找不到这张卡，请刷新' };
      const clean = draftOf(found.card, draft);
      clean.ask = clean.ask.slice(0, MAX_ASK);
      clean.count = Math.min(MAX_COUNT, Math.max(1, clean.count));
      clean.look = clean.look.slice(0, MAX_ASK);
      // an edit that says what the list says is no edit
      if (!clean.look.trim() || clean.look.trim() === clean.lookFrom.trim()) clean.look = clean.lookFrom = '';
      found.store.writeDraft(code, clean, found.card.kind);
      return { ok: true, prompt: promptOf(found.card, clean), look: lookOf(found.card, clean) };
    },

    enqueue(code, count) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const found = find(project, String(code || ''));
      if (!found) return { ok: false, errors: ['找不到这张卡，请刷新'] };
      const { store, card } = found;
      const read = store.readCard(card.code);
      const draft = draftOf(card, read.draft);
      if (draft.mode === 'i2i') {
        if (!read.set.some((s) => s.image === draft.base)) return { ok: false, errors: ['图生图要先选一张卡里已经收进的图作为基础'] };
        const abs = resolveInside(project.outputDir, draft.base);
        if (!abs || !fs.existsSync(abs)) return { ok: false, errors: ['作为基础的那张图已经不在输出目录里了，请换一张'] };
      }
      const templateId = draft.mode === 'i2i' ? I2I : T2I;
      let tpl;
      try {
        tpl = template(templateId);
      } catch (e) {
        return { ok: false, errors: [`出图模板无法加载:${e.message}`] };
      }
      const prompt = promptOf(card, draft);
      const input = { prompt, aspect: draft.aspect, image: draft.mode === 'i2i' ? asRef(draft.base) : '' };
      const check = compileImage(tpl, input);
      if (!check.ok) return { ok: false, errors: check.errors };

      const n = Math.min(MAX_COUNT, Math.max(1, Math.round(Number(count) || draft.count || 1)));
      const batch = `b${read.takes.reduce((max, t) => Math.max(max, Number(String(t.batch || '').slice(1)) || 0), 0) + 1}`;
      const jobs = [];
      for (let i = 0; i < n; i++) {
        const take = store.addTake(card.code, {
          batch, templateId, mode: draft.mode, base: draft.mode === 'i2i' ? draft.base : null,
          ask: draft.ask, prompt, aspect: draft.mode === 'i2i' ? null : draft.aspect,
        });
        const compiled = compileImage(tpl, input, { outputKey: take.outputKey });
        store.updateTake(card.code, take.id, { seed: compiled.seed, width: compiled.width, height: compiled.height });
        jobs.push({
          kind: 'image', family: familyOf(tpl.manifest), projectDir: project.dir, outputDir: project.outputDir,
          shotId: card.code, takeId: take.id, outputKey: take.outputKey, workflow: compiled.workflow,
        });
      }
      // the next round starts at one picture again, however many this one asked for
      store.writeDraft(card.code, { ...(read.draft || draft), count: 1 }, card.kind);
      queue.enqueue(jobs);
      return { ok: true, takeIds: jobs.map((j) => j.takeId) };
    },

    async setTier({ code, takeId, tier, label, confirmed = false }) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      if (!TIERS.has(tier)) return { ok: false, message: '未知的档位' };
      if (!CARD_CODE.test(String(code))) return { ok: false, message: '代号不对，请刷新' };
      const store = createAssetStore(project.dir);
      const read = store.readCard(code);
      const take = read.takes.find((t) => t.id === takeId);
      if (!take) return { ok: false, message: '找不到这一张，请刷新' };
      if (tier !== 'trash') {
        if (take.status !== 'succeeded' || !take.image) return { ok: false, message: '还没生成完成的不能标记' };
        store.change(code, (card) => {
          const takes = card.takes.map((t) => (t.id === takeId ? { ...t, tier } : t));
          if (tier === 'keep') {
            if (card.set.some((s) => s.image === take.image)) return { takes };
            const entry = { image: take.image, label: cleanLabel(label) || labelOf(take.ask), takeId, addedAt: Date.now() };
            return { takes, set: [...card.set, entry], main: card.main || take.image };
          }
          return { takes, ...withoutImage(card, take.image) };
        });
        return { ok: true, message: '' };
      }
      if (working(take)) return { ok: false, message: '这一张还在生成，先在任务列表里取消它' };
      if (!confirmed && take.image && read.set.some((s) => s.image === take.image)) {
        const users = shotsUsing(project, take.image);
        if (users.length) {
          return { ok: false, needsConfirm: true, message: `镜头 ${users.join('、')} 正把这张图当参考图用，删掉后它们会找不到这张图。仍然删掉？` };
        }
      }
      for (const file of takeFiles(project.outputDir, take)) {
        try {
          await trash(file);
        } catch (e) {
          return { ok: false, message: `移到回收站失败:${e.message}` };
        }
      }
      store.change(code, (card) => ({
        takes: card.takes.map((t) => (t.id === takeId ? { ...t, tier: 'trash' } : t)),
        ...(take.image ? withoutImage(card, take.image) : {}),
      }));
      return { ok: true, message: '已移到回收站' };
    },

    setMain(code, image) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      if (!CARD_CODE.test(String(code))) return { ok: false, message: '代号不对，请刷新' };
      const store = createAssetStore(project.dir);
      if (!store.readCard(code).set.some((s) => s.image === image)) return { ok: false, message: '只有收进卡里的图才能设为主图' };
      store.change(code, () => ({ main: image }));
      return { ok: true };
    },

    relabel(code, image, label) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      if (!CARD_CODE.test(String(code))) return { ok: false, message: '代号不对，请刷新' };
      const text = cleanLabel(label);
      if (!text) return { ok: false, message: '标签不能为空' };
      const store = createAssetStore(project.dir);
      if (!store.readCard(code).set.some((s) => s.image === image)) return { ok: false, message: '这张图不在卡里，请刷新' };
      store.change(code, (card) => ({ set: card.set.map((s) => (s.image === image ? { ...s, label: text } : s)) }));
      return { ok: true };
    },

    // Out of the card only: the file stays where it is, and a take it came from goes back to 候选.
    unkeep(code, image) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      if (!CARD_CODE.test(String(code))) return { ok: false, message: '代号不对，请刷新' };
      const store = createAssetStore(project.dir);
      if (!store.readCard(code).set.some((s) => s.image === image)) return { ok: false, message: '这张图不在卡里，请刷新' };
      store.change(code, (card) => ({
        takes: card.takes.map((t) => (t.image === image && t.tier === 'keep' ? { ...t, tier: 'cand' } : t)),
        ...withoutImage(card, image),
      }));
      return { ok: true };
    },

    // A picture made before there were cards joins one. Nothing is renamed or moved; one from the project's
    // ref/ folder is copied into the output folder, where ComfyUI and the shot page can use it.
    adopt(code, relPath) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const found = find(project, String(code || ''));
      if (!found) return { ok: false, message: '找不到这张卡，请刷新' };
      const read = found.store.readCard(found.card.code);
      const pick = existingFor(project, found.card.code, read.set.map((s) => s.image)).find((e) => e.relPath === relPath);
      if (!pick || !OUTPUT_PICTURE.test(pick.image)) return { ok: false, message: '找不到这张图，请刷新' };
      try {
        if (pick.source !== 'output') {
          const root = pick.source === 'ref' ? path.join(project.dir, 'ref') : path.join(project.dir, 'input');
          materialize({ source: pick.source, relPath: pick.relPath, name: path.basename(pick.relPath), abs: path.join(root, pick.relPath) }, project.outputDir);
        }
      } catch (e) {
        return { ok: false, message: `复制到输出目录失败:${e.message}` };
      }
      found.store.change(found.card.code, (card) => ({
        kind: card.kind || found.card.kind,
        set: [...card.set, { image: pick.image, label: cleanLabel(pick.label) || '参考图', takeId: null, addedAt: Date.now() }],
        main: card.main || pick.image,
      }));
      return { ok: true, image: pick.image };
    },

    // { CODE: main picture or '' } for every listed card, for the shot page's script import.
    mains() {
      const project = getProject();
      if (!project) return {};
      const { store, cards } = collect(project);
      return Object.fromEntries(cards.filter((c) => !c.orphan).map((c) => [c.code, store.readCard(c.code).main || '']));
    },

    // Every listed card with its look and main picture, for a new shot written by the AI to pick from.
    brief() {
      const project = getProject();
      if (!project) return [];
      const { store, cards } = collect(project);
      return cards.filter((c) => !c.orphan).map((c) => ({ code: c.code, kind: c.kind, name: c.name, description: c.description, main: store.readCard(c.code).main || '' }));
    },

    // Every card's kept pictures, main first, for the shot page's reference picker.
    sets() {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const { store, cards } = collect(project);
      return {
        ok: true,
        cards: cards.map((c) => {
          const read = store.readCard(c.code);
          const set = [...read.set].sort((a, b) => Number(b.image === read.main) - Number(a.image === read.main));
          return { code: c.code, kind: c.kind, name: c.name, images: set.map((s) => ({ value: asRef(s.image), label: s.label, main: s.image === read.main })) };
        }).filter((c) => c.images.length),
      };
    },
  };
}

module.exports = { createAssetService, T2I, I2I };
