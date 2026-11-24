// Everything the shot page does: shots of the active script project grouped into episodes, each shot's draft
// (prompt, references, parameters, template, continuation), taking N more takes, and the three tiers.
// Plain Node, no Electron: the queue and the recycle bin are handed in.
const path = require('node:path');
const { listScriptShots, reviseScriptShotPrompt, removeScriptShot, castGaps, pictureMismatches } = require('./script-shots');
const { loadTemplate, templateForm, valueAt, listTemplates } = require('./workflow-template');
const { compileWorkflow } = require('./workflow-compile');
const { familyOf } = require('./image-compile');
const { createTakeStore, SHOT_ID } = require('./take-store');
const { continuationShots } = require('./clip-keep');
const { takeFiles } = require('./take-outputs');
const { estimateRun } = require('./run-estimate');
const links = require('./shot-links');
const R = require('./take-rules');
const { blockingWarnings, blockingBrief, factsText } = require('./scene-blocking');

const DEFAULT_TEMPLATE = 'minimax-h3-wenwu-cont';
const MAX_TAKES = 16;
const NO_PROJECT = { ok: false, noProject: true, message: '请先选择或新建一个剧本项目' };
const MODES = new Set(['none', 'previous', 'shot', 'legacy']);

const episodeOf = (shotId) => {
  const m = /^(?:MOTION|HAND)-([A-Z0-9]+)-/i.exec(String(shotId));
  return m ? m[1].toUpperCase() : '';
};

// getBlocking(shotId): what the shot's camera sees in a whitebox scene's blocking ({ facts }), or null
// getCards(): the project's cards for a new shot to pick from ([{ code, kind, name, description, main }])
function createShotService({ getProject, templatesDir, queue, trash, getTargetId = () => 'local', getDefaultTemplate = () => DEFAULT_TEMPLATE, getCardMains = () => ({}), getBlocking = () => null, getCards = () => [] }) {
  const factsOf = (shotId) => {
    try { const b = getBlocking(shotId); return b && b.facts && b.facts.camera ? b.facts : null; } catch { return null; }
  };
  // pictures are made on the assets page, and upscaling is a step after a take, not a way to make one
  const templateList = () => listTemplates(templatesDir).filter((t) => t.kind !== 'image' && t.kind !== 'upscale');
  const templateNames = () => Object.fromEntries(templateList().map((t) => [t.dirName, t.name]));
  const loadById = (id) => loadTemplate(path.join(templatesDir, id));

  // A new length in the script replaces the draft's. The draft remembers the script length it last saw
  // (scriptDuration), so a length changed by hand stays until the script itself changes.
  function syncDuration(store, shot) {
    if (!shot.duration) return;
    const { draft } = store.readShot(shot.id);
    if (!draft || !draft.values || draft.scriptDuration === shot.duration) return;
    if (draft.scriptDuration === undefined && Number(draft.values.duration) === shot.duration) return;
    store.writeDraft(shot.id, { ...draft, values: { ...draft.values, duration: shot.duration }, scriptDuration: shot.duration });
  }

  // What the script asks a shot to continue from: nothing, the shot just before, or a named shot of the episode.
  function scriptContinuation(shot) {
    if (!shot.continuePrevious) return { mode: 'none' };
    return shot.continueFrom ? { mode: 'shot', shotId: shot.continueFrom } : { mode: 'previous' };
  }
  const continuationKey = (c) => (!c || !c.mode || c.mode === 'none' ? 'none' : c.mode === 'shot' ? `shot:${c.shotId}` : c.mode);

  // Same rule as the length: the draft remembers the continuation it last took from the script
  // (scriptContinuation), so one chosen by hand stays until the script itself changes.
  function syncContinuation(store, shot) {
    const wanted = scriptContinuation(shot);
    const key = continuationKey(wanted);
    const { draft } = store.readShot(shot.id);
    if (!draft || draft.scriptContinuation === key) return;
    if (draft.scriptContinuation === undefined && continuationKey(draft.continuation) === key) return;
    store.writeDraft(shot.id, { ...draft, continuation: wanted, scriptContinuation: key });
  }

  // The script's 输入参考图 as pictures: each card's main picture, in the script's order (a card without one yet is
  // left out, and the key changes once it has one). null when the script names none.
  function scriptReferences(shot, mains) {
    if (!Array.isArray(shot.references) || !shot.references.length) return null;
    const codes = shot.references.map((r) => String(r.id || '').replace(/^IMG-/i, '').toUpperCase());
    return {
      refs: codes.filter((c) => mains[c]).map((c) => `${mains[c]} [output]`),
      key: codes.map((c) => `${c}=${mains[c] || ''}`).join('|'),
    };
  }

  // Same rule as the length: the pictures follow the script, and the draft remembers what it last took
  // (scriptReferences), so pictures chosen by hand stay until the script's list changes. A draft from before this
  // was tracked keeps its pictures if it was ever rendered (they may have been chosen by hand).
  function syncReferences(store, shot, mains) {
    const wanted = scriptReferences(shot, mains);
    if (!wanted) return;
    const { draft, takes } = store.readShot(shot.id);
    if (!draft || !draft.values || draft.scriptReferences === wanted.key) return;
    const same = JSON.stringify(draft.values.references || []) === JSON.stringify(wanted.refs);
    if (draft.scriptReferences === undefined && (same || (takes || []).length)) {
      store.writeDraft(shot.id, { ...draft, scriptReferences: wanted.key });
      return;
    }
    store.writeDraft(shot.id, { ...draft, values: { ...draft.values, references: wanted.refs }, scriptReferences: wanted.key });
  }

  // All shots of the project, script ones fresh from the documents, grouped and ordered per episode.
  function collect(project) {
    const store = createTakeStore(project.dir);
    const warnings = [];
    const listed = listScriptShots({ docsDir: project.docsDir });
    if (!listed.ok && !listed.noProject) warnings.push(listed.message);
    if (store.manualWarning()) warnings.push(store.manualWarning());
    for (const shot of listed.shots || []) {
      for (const m of pictureMismatches(shot)) {
        warnings.push(m.title
          ? `${shot.id.slice(-3)} 提示词里 Subject ${m.subject} 写的是${m.says}，可 <Picture ${m.picture}> 是《${m.title}》：参考图顺序和提示词里的图号对不上`
          : `${shot.id.slice(-3)} 提示词里用了 <Picture ${m.picture}>，可这一镜没有第 ${m.picture} 张参考图`);
      }
      for (const w of blockingWarnings({ prompt: shot.prompt, facts: factsOf(shot.id), references: shot.references })) warnings.push(`${shot.id.slice(-3)} ${w}`);
    }
    for (const gap of castGaps(listed.shots || [])) {
      // the shot's blocking knows who its camera cannot see: they are still there, only out of the picture
      const facts = factsOf(gap.id);
      const g = facts ? { ...gap, missing: gap.missing.filter((t) => !facts.people.some((p) => p.frame === 'out' && t.includes(p.name))) } : gap;
      if (!g.missing.length) continue;
      warnings.push(`${g.id.slice(-3)} 接着 ${g.from.slice(-3)} 拍，但 ${g.from.slice(-3)} 里的${g.missing.map((t) => `《${t}》`).join('')}这一镜参考图里没有：人还在画面里的话会被画掉或变成别人，请把参考图加上，或在上一镜写清他离开`);
    }
    const script = (listed.shots || []).map((s) => ({
      id: s.id, episode: s.episode, title: s.title, duration: Number.isFinite(s.duration) ? s.duration : null,
      prompt: s.prompt, continuePrevious: s.continuePrevious, continueFrom: s.continueFrom || '', source: 'script',
      references: s.references || [],
    }));
    const mains = script.some((s) => s.references.length) ? getCardMains() || {} : {};
    for (const s of script) {
      syncDuration(store, s);
      syncContinuation(store, s);
      syncReferences(store, s, mains);
    }
    const manual = store.readManual().map((m) => ({ ...m, duration: null, source: 'manual' }));
    const known = new Set([...script, ...manual].map((s) => s.id));
    const orphans = store.listShotIds().filter((id) => !known.has(id) && episodeOf(id))
      .map((id) => ({ id, episode: episodeOf(id), title: '剧本里已没有', duration: null, source: 'orphan' }));
    const episodes = new Map();
    const bucket = (ep) => {
      if (!episodes.has(ep)) episodes.set(ep, { script: [], manual: [], orphan: [] });
      return episodes.get(ep);
    };
    for (const s of script) bucket(s.episode).script.push(s);
    for (const m of manual) bucket(m.episode).manual.push(m);
    for (const o of orphans) bucket(o.episode).orphan.push(o);
    const ordered = [...episodes.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'zh', { numeric: true }))
      .map(([id, e]) => ({ id, order: [...R.orderEpisode(e.script, e.manual), ...e.orphan] }));
    return { store, episodes: ordered, warnings };
  }

  function statesOf(store, order) {
    return new Map(order.map((s) => {
      const read = store.readShot(s.id);
      return [s.id, { takes: read.takes, draft: read.draft, warning: read.warning }];
    }));
  }

  // Where the shot sits: its episode's order, the shot itself and the store.
  function locate(project, shotId) {
    const all = collect(project);
    for (const episode of all.episodes) {
      const shot = episode.order.find((s) => s.id === shotId);
      if (shot) return { ...all, episode, shot };
    }
    return null;
  }

  // A shot opened for the first time takes the template and settings of the shot before it.
  function defaultDraft(store, order, shot) {
    const at = order.findIndex((s) => s.id === shot.id);
    let previous = null;
    for (let i = at - 1; i >= 0 && !previous; i--) previous = store.readShot(order[i].id).draft;
    let templateId = previous && previous.templateId;
    let values = previous ? { ...previous.values } : null;
    if (!templateId || !templateList().some((t) => t.dirName === templateId && t.compatible)) {
      templateId = getDefaultTemplate();
      values = null;
    }
    if (!values) values = { ...templateForm(loadById(templateId)).defaults };
    delete values.continuationEnabled;
    delete values.continuationClip;
    values.prompt = shot.source === 'script' ? shot.prompt || '' : '';
    if (shot.duration) values.duration = shot.duration;
    // the script's pictures, not the ones the shot before happened to have
    const pictures = shot.source === 'script' ? scriptReferences(shot, getCardMains() || {}) : null;
    if (pictures) values.references = pictures.refs;
    if (shot.source !== 'script') return { templateId, values, continuation: { mode: 'none' } };
    const continuation = scriptContinuation(shot);
    const draft = { templateId, values, continuation, scriptContinuation: continuationKey(continuation), ...(pictures ? { scriptReferences: pictures.key } : {}) };
    return shot.duration ? { ...draft, scriptDuration: shot.duration } : draft;
  }

  function draftOf(store, order, shot) {
    let draft = store.readShot(shot.id).draft;
    if (!draft) {
      draft = defaultDraft(store, order, shot);
      store.writeDraft(shot.id, draft);
    }
    // the script document is the home of a script shot's prompt
    if (shot.source === 'script') draft = { ...draft, values: { ...draft.values, prompt: shot.prompt || '' } };
    return draft;
  }

  function continuationFor({ order, states, shot, draft, template }) {
    const supported = templateForm(template).capabilities.continuation;
    const resolved = supported
      ? R.resolveContinuation({ order, states, shotId: shot.id, choice: draft.continuation, templateId: draft.templateId, templateNames: templateNames() })
      : { ok: true, enabled: false };
    return { supported, resolved };
  }

  // A shot's prompt: the script's for a script shot, the draft's for a hand-made one.
  const promptOf = (store, shot) => (shot.source === 'script' ? shot.prompt || '' : ((store.readShot(shot.id).draft || {}).values || {}).prompt || '');

  // The shot right after a new hand-made one, when it continues "the shot before": that is now the new shot.
  function followerNotice(project, ep, shotId) {
    const { store, episodes } = collect(project);
    const order = (episodes.find((e) => e.id === ep) || { order: [] }).order;
    const at = order.findIndex((s) => s.id === shotId);
    const follower = at >= 0 ? order[at + 1] : null;
    if (!follower) return '';
    const draft = store.readShot(follower.id).draft;
    const choice = draft ? draft.continuation : follower.source === 'script' ? scriptContinuation(follower) : null;
    if (!choice || choice.mode !== 'previous') return '';
    const no = R.shotNo(follower.id);
    const was = at > 0 ? order[at - 1] : null;
    // the script can name a script shot to continue from; anything else is changed on the shot itself
    const fix = was && was.source === 'script' && follower.source === 'script'
      ? `；要接原来的镜头 ${R.shotNo(was.id)}，在剧本里把镜头 ${no} 写成「接续上一镜：是（接 ${R.shotNo(was.id)}）」，或到镜头 ${no} 里改接续`
      : was ? `；要接原来的镜头 ${R.shotNo(was.id)}，到镜头 ${no} 里改接续` : '';
    return `镜头 ${no} 设的是「接上一镜」，插进来以后它接的是这个新镜头${fix}`;
  }

  return {
    episodes() {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const { store, episodes, warnings } = collect(project);
      const notes = links.readNotes(project.dir);
      return {
        ok: true,
        warnings,
        episodes: episodes.map(({ id, order }) => ({
          id,
          shots: order.map((s) => ({
            id: s.id, n: R.shotNo(s.id), title: s.title, source: s.source, duration: s.duration,
            status: R.shotStatus(store.readShot(s.id).takes),
            linkNote: !!notes[s.id],
          })),
        })),
      };
    },

    // The shots around one, for a rewrite to keep them joined up: { text, ids } (ids it may name as affected).
    around(shotId) {
      const project = getProject();
      const found = project && locate(project, shotId);
      if (!found) return { text: '', ids: [] };
      const { store, episode } = found;
      const order = episode.order.map((s) => ({ id: s.id, prompt: promptOf(store, s), continuePrevious: !!s.continuePrevious }));
      const drafts = new Map(episode.order.map((s) => [s.id, store.readShot(s.id).draft]));
      const near = links.neighboursOf({ order, drafts, shotId });
      return { text: links.neighbourText(near), ids: [near.previous, ...near.next].filter(Boolean).map((s) => s.id) };
    },

    // The given shots' prompts, for a card rewrite to see how they describe it: { text, ids }.
    users(shotIds) {
      const project = getProject();
      if (!project) return { text: '', ids: [] };
      const { store, episodes } = collect(project);
      const wanted = new Set(shotIds);
      const shots = episodes.flatMap((e) => e.order).filter((s) => wanted.has(s.id)).map((s) => ({ id: s.id, prompt: promptOf(store, s) }))
        .filter((s) => s.prompt.trim());
      return { text: links.usageText(shots), ids: shots.map((s) => s.id) };
    },

    // What a rewrite of a shot that is not open needs: its prompt and the context the page would send.
    revisionTarget(shotId) {
      const d = this.detail(shotId);
      if (!d.ok) return d;
      const { supported, resolved } = d.continuation;
      return {
        ok: true,
        text: d.draft.values.prompt || '',
        context: { references: d.draft.values.references || [], duration: d.draft.values.duration, continuation: !!(supported && resolved.ok && resolved.enabled), blocking: this.blockingBrief(shotId) },
      };
    },

    // The shot's blocking as a rewrite is told it ('' when no scene covers the shot).
    blockingBrief(shotId) {
      return blockingBrief(factsOf(String(shotId)));
    },

    // Where the shot's prompt says something its blocking does not: [text].
    blockingCheck(shotId) {
      const project = getProject();
      const found = project && locate(project, String(shotId));
      if (!found) return [];
      const { store, shot } = found;
      return blockingWarnings({ prompt: promptOf(store, shot), facts: factsOf(shot.id), references: shot.references || [] });
    },

    // The shot's pictures by name and kind, for a rewrite that has to number them right.
    referenceText(shotId) {
      const project = getProject();
      const found = project && locate(project, String(shotId));
      if (!found || !(found.shot.references || []).length) return '';
      return `这一镜的参考图：${found.shot.references.map((r) => `<Picture ${r.order}> = 《${r.title || r.id}》（${/身份/.test(r.use || '') ? '人物' : '场景，不是人'}）`).join('；')}`;
    },

    // <Picture n> numbers in the prompt that point at the wrong reference: [text].
    pictureCheck(shotId) {
      const project = getProject();
      const found = project && locate(project, String(shotId));
      if (!found) return [];
      const { store, shot } = found;
      return pictureMismatches({ prompt: promptOf(store, shot), references: shot.references || [] }).map((m) => (m.title
        ? `提示词里 Subject ${m.subject} 写的是${m.says}，可 <Picture ${m.picture}> 是《${m.title}》，按参考图现在的顺序把图号改对`
        : `提示词里用了 <Picture ${m.picture}>，可这一镜没有第 ${m.picture} 张参考图`));
    },

    // The prompts of the given shots, for laying out their blocking: [{ id, text }].
    prompts(shotIds) {
      const project = getProject();
      if (!project) return [];
      const { store, episodes } = collect(project);
      const all = episodes.flatMap((e) => e.order);
      return shotIds.map((id) => all.find((s) => s.id === id)).filter(Boolean).map((s) => ({ id: s.id, text: promptOf(store, s), references: s.references || [] }));
    },

    // A shot that should have changed along with another one but was left as it is.
    noteLink(shotId, note) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      if (!SHOT_ID.test(String(shotId))) return { ok: false, message: '镜头编号不对，请刷新' };
      links.setNote(project.dir, shotId, note);
      return { ok: true };
    },

    clearLink(shotId) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      links.clearNote(project.dir, shotId);
      return { ok: true };
    },

    detail(shotId) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const found = locate(project, shotId);
      if (!found) return { ok: false, message: '找不到这个镜头，请刷新' };
      const { store, episode, shot } = found;
      const draft = draftOf(store, episode.order, shot);
      let template;
      try {
        template = loadById(draft.templateId);
      } catch (e) {
        return { ok: false, message: `工作流模板无法加载:${e.message}` };
      }
      const form = templateForm(template);
      const { continuationEnabled, continuationClip, ...defaults } = form.defaults; // continuation is decided per take
      const shown = { ...draft, values: { ...defaults, ...draft.values } };
      const states = statesOf(store, episode.order);
      const stale = R.staleness({ order: episode.order, states });
      const takes = states.get(shot.id).takes.map((t) => ({ ...t, stale: stale.get(t.id) || '' }));
      const { supported, resolved } = continuationFor({ order: episode.order, states, shot, draft, template });
      const options = [
        { label: '不接', choice: { mode: 'none' } },
        { label: '接上一镜', choice: { mode: 'previous' } },
        ...episode.order
          .filter((s) => s.id !== shot.id && R.pickOf(states.get(s.id).takes))
          .map((s) => ({ label: `接 镜头 ${R.shotNo(s.id)}`, choice: { mode: 'shot', shotId: s.id } })),
        ...continuationShots(project.outputDir)
          .map((k) => ({ label: `旧版保留 · 分镜 ${k.shot}`, choice: { mode: 'legacy', legacyShot: k.shot } })),
      ];
      return {
        ok: true,
        shot: { ...shot, n: R.shotNo(shot.id), episode: episode.id },
        draft: shown,
        form,
        takes,
        warning: states.get(shot.id).warning,
        continuation: { supported, choice: draft.continuation, resolved, options },
        templates: templateList().map((t) => ({ id: t.dirName, name: t.name, compatible: t.compatible })),
        linkNote: links.readNotes(project.dir)[shot.id] || null,
        blocking: factsText(factsOf(shot.id)),
      };
    },

    saveDraft(shotId, draft) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      if (!draft || typeof draft.templateId !== 'string' || !draft.values || typeof draft.values !== 'object') {
        return { ok: false, message: '镜头设置格式不对' };
      }
      if (!SHOT_ID.test(shotId)) return { ok: false, message: '镜头编号不对，请刷新' };
      const continuation = draft.continuation && MODES.has(draft.continuation.mode) ? draft.continuation : { mode: 'none' };
      const found = locate(project, shotId);
      const fromScript = found && found.shot.source === 'script';
      const scriptDuration = fromScript && found.shot.duration ? { scriptDuration: found.shot.duration } : {};
      const scriptContinuationSeen = fromScript ? { scriptContinuation: continuationKey(scriptContinuation(found.shot)) } : {};
      const pictures = fromScript ? scriptReferences(found.shot, getCardMains() || {}) : null;
      const scriptReferencesSeen = pictures ? { scriptReferences: pictures.key } : {};
      createTakeStore(project.dir).writeDraft(shotId, { templateId: draft.templateId, values: draft.values, continuation, ...scriptDuration, ...scriptContinuationSeen, ...scriptReferencesSeen });
      return { ok: true };
    },

    writePrompt(shotId, { expected, prompt }) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const found = locate(project, shotId);
      if (!found) return { ok: false, message: '找不到这个镜头，请刷新' };
      if (found.shot.source !== 'script') {
        const draft = draftOf(found.store, found.episode.order, found.shot);
        found.store.writeDraft(shotId, { ...draft, values: { ...draft.values, prompt: String(prompt || '') } });
        links.clearNote(project.dir, shotId); // its prompt changed: whatever it was waiting for has been looked at
        return { ok: true, message: '' };
      }
      const r = reviseScriptShotPrompt({ docsDir: project.docsDir, shotId, expectedPrompt: expected, prompt });
      if (!r.ok && (r.conflict || /其他(地方|程序)/.test(r.message || ''))) return { ok: false, message: '剧本文件已在外面修改，请刷新后再改' };
      if (r.ok) links.clearNote(project.dir, shotId);
      return r.ok ? { ok: true, message: '' } : r;
    },

    enqueue(shotId, count) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const found = locate(project, shotId);
      if (!found) return { ok: false, errors: ['找不到这个镜头，请刷新'] };
      const { store, episode, shot } = found;
      const draft = draftOf(store, episode.order, shot);
      let template;
      try {
        template = loadById(draft.templateId);
      } catch (e) {
        return { ok: false, errors: [`工作流模板无法加载:${e.message}`] };
      }
      const states = statesOf(store, episode.order);
      const { resolved } = continuationFor({ order: episode.order, states, shot, draft, template });
      if (!resolved.ok) return { ok: false, errors: [resolved.message] };
      const values = { ...draft.values, continuationEnabled: !!resolved.enabled, continuationClip: resolved.enabled ? resolved.clip : '' };
      const check = compileWorkflow(template, values);
      if (!check.ok) return { ok: false, errors: check.errors };

      const n = Math.min(MAX_TAKES, Math.max(1, Math.round(Number(count) || 1)));
      const seedBinding = template.manifest.bindings.seed;
      const estimate = estimateRun(store.listShotIds().flatMap((id) => store.readShot(id).takes), { templateId: draft.templateId, values, renderedOn: getTargetId() });
      const jobs = [];
      for (let i = 0; i < n; i++) {
        const fixed = values.seedMode === 'fixed';
        const take = store.addTake(shot.id, {
          status: 'queued', templateId: draft.templateId, values,
          continuedFrom: resolved.enabled ? resolved.from : null,
        });
        const compiled = compileWorkflow(template, fixed ? { ...values, seed: Number(values.seed) + i } : values, { outputKey: take.outputKey });
        const seed = seedBinding ? valueAt(compiled.workflow, seedBinding) : null;
        store.updateTake(shot.id, take.id, { seed });
        jobs.push({ kind: 'video', family: familyOf(template.manifest), projectDir: project.dir, outputDir: project.outputDir, shotId: shot.id, takeId: take.id, outputKey: take.outputKey, workflow: compiled.workflow, estimate });
      }
      queue.enqueue(jobs);
      return { ok: true, takeIds: jobs.map((j) => j.takeId) };
    },

    async setTier({ shotId, takeId, tier, confirmed = false }) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      if (!['', 'cand', 'pick', 'trash'].includes(tier)) return { ok: false, message: '未知的档位' };
      if (!SHOT_ID.test(String(shotId))) return { ok: false, message: '镜头编号不对，请刷新' };
      const store = createTakeStore(project.dir);
      const { takes } = store.readShot(shotId);
      const take = takes.find((t) => t.id === takeId);
      if (!take) return { ok: false, message: '找不到这一条，请刷新' };
      if (tier !== 'trash') {
        if (take.status !== 'succeeded') return { ok: false, message: '还没生成完成的不能标记' };
        store.replaceTakes(shotId, R.applyTier(takes, takeId, tier));
        return { ok: true, message: '' };
      }
      if (take.status === 'queued' || take.status === 'running') return { ok: false, message: '这一条还在生成，先在任务列表里取消它' };
      if (!confirmed) {
        const found = locate(project, shotId);
        const order = found ? found.episode.order : [{ id: shotId }];
        const deps = R.dependents(statesOf(store, order), takeId);
        if (deps.length) {
          const nos = [...new Set(deps.map((d) => R.shotNo(d.shotId)))].join('、');
          return { ok: false, needsConfirm: true, message: `镜头 ${nos} 接的是这一条，删掉后它们的接续来源就没了。仍然删掉？` };
        }
      }
      for (const file of takeFiles(project.outputDir, take)) {
        try {
          await trash(file);
        } catch (e) {
          return { ok: false, message: `移到回收站失败:${e.message}` };
        }
      }
      store.updateTake(shotId, takeId, { tier: 'trash' });
      return { ok: true, message: '已移到回收站' };
    },

    // place: 'before' / 'after' the shot `anchor` of the episode, or 'end'. Without a place, `after` keeps its older
    // meaning. notice: what the new shot changes for the shot after it, when that one continues "the shot before".
    createManual({ episode, title, after, anchor, place }) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const ep = String(episode || '').toUpperCase();
      if (!/^[A-Z0-9]+$/.test(ep)) return { ok: false, message: '集号只能是字母和数字，比如 E01' };
      const name = String(title || '').trim() || '新镜头';
      const store = createTakeStore(project.dir);
      if (place === undefined) return { ok: true, id: store.addManual({ episode: ep, title: name, after: after || null }).id };
      if (!['before', 'after', 'end'].includes(place)) return { ok: false, message: '插入位置不对，请刷新' };
      const next = place === 'end' ? null : String(anchor || '');
      if (next !== null) {
        const episodeOrder = (collect(project).episodes.find((e) => e.id === ep) || { order: [] }).order;
        const target = episodeOrder.find((s) => s.id === next);
        if (!target) return { ok: false, message: '当前镜头不在这一集里，请刷新后重新选一个镜头' };
        if (target.source === 'orphan') return { ok: false, message: '这个镜头剧本里已经没有了，不能挨着它插，请换一个镜头' };
      }
      const shot = next === null ? store.addManual({ episode: ep, title: name, after: null }) : store.addManual({ episode: ep, title: name, anchor: next, place });
      return { ok: true, id: shot.id, notice: followerNotice(project, ep, shot.id) };
    },

    // What a new shot written by the AI is told: the shots it will sit between (by the same place rule as
    // createManual), the cards it can hang, and how many the template takes.
    composeContext({ episode, anchor, place }) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const ep = String(episode || '').toUpperCase();
      const { store, episodes } = collect(project);
      const order = ((episodes.find((e) => e.id === ep) || { order: [] }).order).filter((s) => s.source !== 'orphan');
      const at = place === 'end' || !anchor ? -1 : order.findIndex((s) => s.id === anchor);
      if (place !== 'end' && anchor && at < 0) return { ok: false, message: '当前镜头不在这一集里，请刷新后重新选一个镜头' };
      const [prev, next] = at < 0 ? [order[order.length - 1], null] : place === 'before' ? [order[at - 1], order[at]] : [order[at], order[at + 1]];
      const brief = (s) => (s ? { id: s.id, prompt: promptOf(store, s) } : null);
      const previousDraft = prev ? store.readShot(prev.id).draft : null;
      let maxReferences = 6;
      try {
        maxReferences = templateForm(loadById((previousDraft && previousDraft.templateId) || getDefaultTemplate())).limits.maxReferences || 6;
      } catch { /* the usual six */ }
      const cards = (getCards() || []).filter((c) => c && c.code);
      return { ok: true, previous: brief(prev), next: brief(next), cards, maxReferences };
    },

    // A hand-made shot with what the AI wrote: its prompt, length, cards (their main pictures, in order) and
    // whether it continues the shot before.
    createComposed({ episode, anchor, place, title, prompt, duration, codes = [], continues = false }) {
      const made = this.createManual({ episode, title, anchor, place });
      if (!made.ok) return made;
      const project = getProject();
      const found = locate(project, made.id);
      if (!found) return made;
      const mains = getCardMains() || {};
      const draft = draftOf(found.store, found.episode.order, found.shot);
      const references = codes.map((c) => mains[String(c).toUpperCase()]).filter(Boolean).map((p) => `${p} [output]`);
      found.store.writeDraft(made.id, {
        ...draft,
        values: { ...draft.values, prompt: String(prompt || ''), ...(Number(duration) > 0 ? { duration: Number(duration) } : {}), references },
        continuation: continues ? { mode: 'previous' } : { mode: 'none' },
      });
      return made;
    },

    // Takes a shot off the episode: a script shot's section leaves the script document (its old version stays in
    // the document's history), its videos go to the recycle bin and its record to .blackbox/deleted/. Unconfirmed,
    // it only says what deleting it would do ({ needsConfirm, message }). next: the shot to show instead.
    async deleteShot({ shotId, confirmed = false }) {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const id = String(shotId || '');
      const found = locate(project, id);
      if (!found) return { ok: false, message: '找不到这个镜头，请刷新' };
      const { store, episode, shot } = found;
      const order = episode.order;
      const at = order.findIndex((s) => s.id === id);
      const { takes } = store.readShot(id);
      if (takes.some((t) => t.status === 'queued' || t.status === 'running')) return { ok: false, message: '这一镜还有在生成的，先在任务列表里取消它们' };
      const live = takes.filter((t) => t.tier !== 'trash');
      const states = statesOf(store, order);
      const choiceOf = (s) => {
        const draft = store.readShot(s.id).draft;
        return draft ? draft.continuation : s.source === 'script' ? scriptContinuation(s) : null;
      };
      const no = R.shotNo(id);
      if (!confirmed) {
        const lines = [`删掉镜头 ${no}${shot.title ? `「${shot.title}」` : ''}？`];
        if (shot.source === 'script') lines.push('它在剧本文件里的那一段会删掉（删之前的版本留在文档历史里）。');
        const made = live.filter((t) => t.status === 'succeeded').length;
        if (made) lines.push(`它已生成的 ${made} 条视频会移到回收站。`);
        const deps = [...new Set(live.flatMap((t) => R.dependents(states, t.id)).map((d) => d.shotId))].filter((s) => s !== id);
        if (deps.length) lines.push(`镜头 ${deps.map(R.shotNo).join('、')} 是接着它的视频生成的，删掉后那几条的接续来源就没了。`);
        const follower = order[at + 1];
        const fc = follower && choiceOf(follower);
        if (fc && fc.mode === 'previous') {
          lines.push(at > 0 ? `镜头 ${R.shotNo(follower.id)} 设的是「接上一镜」，删掉后它接的是镜头 ${R.shotNo(order[at - 1].id)}。` : `镜头 ${R.shotNo(follower.id)} 设的是「接上一镜」，删掉后它成了本集第一镜，没有可接的。`);
        }
        const named = order.filter((s) => s.id !== id && (choiceOf(s) || {}).mode === 'shot' && choiceOf(s).shotId === id);
        if (named.length) lines.push(`镜头 ${named.map((s) => R.shotNo(s.id)).join('、')} 设的是接这一镜，删掉后要到那里改接续。`);
        return { ok: false, needsConfirm: true, message: lines.join('\n') };
      }
      let removed = {};
      if (shot.source === 'script') {
        const r = removeScriptShot({ docsDir: project.docsDir, shotId: id });
        if (!r.ok) return r;
        removed = { source: r.source, removedText: r.removed };
      }
      let stuck = 0;
      for (const take of live) {
        for (const file of takeFiles(project.outputDir, take)) {
          try { await trash(file); } catch { stuck++; }
        }
      }
      // hand-made shots placed next to it stay where they were: before the next script shot, else after the last one
      const script = (s) => s.source === 'script' && s.id !== id;
      const after = order.slice(at + 1).find(script);
      const before = [...order.slice(0, at)].reverse().find(script);
      const moved = after ? { anchor: after.id, place: 'before' } : before ? { anchor: before.id, place: 'after' } : { anchor: null };
      store.removeShot(id, { moved, extra: removed });
      links.clearNote(project.dir, id);
      const next = order[at + 1] || order[at - 1] || null;
      return {
        ok: true, next: next ? next.id : '',
        message: stuck ? `已删掉镜头 ${no}，有 ${stuck} 个文件没能移到回收站（可能正被占用），可以到输出文件夹手动删` : `已删掉镜头 ${no}`,
      };
    },

    // Continuation files that takes still own: the clip-folder clean-up must never touch these.
    // .unsure: a record could not be read, so every continuation file a take might own must be left alone.
    usedContexts() {
      const project = getProject();
      const used = new Set();
      used.unsure = false;
      if (!project) return used;
      const store = createTakeStore(project.dir);
      used.unsure = store.isDamaged();
      for (const id of store.listShotIds()) {
        for (const t of store.readShot(id).takes) if (t.context && t.tier !== 'trash') used.add(t.context);
      }
      return used;
    },

    // The chosen take of every shot in an episode, in order: what "upscale the episode" works through.
    picks(episodeId) {
      const project = getProject();
      if (!project) return [];
      const { store, episodes } = collect(project);
      const episode = episodes.find((e) => e.id === episodeId);
      if (!episode) return [];
      return episode.order
        .map((s) => ({ shotId: s.id, take: R.pickOf(store.readShot(s.id).takes) }))
        .filter((p) => p.take);
    },

    timeline(episodeId, gapMode = 'black') {
      const project = getProject();
      if (!project) return NO_PROJECT;
      const { store, episodes } = collect(project);
      const episode = episodes.find((e) => e.id === episodeId);
      if (!episode) return { ok: true, total: 0, segments: [] };
      return { ok: true, ...R.timeline({ order: episode.order, states: statesOf(store, episode.order), gapMode }) };
    },
  };
}

module.exports = { createShotService, DEFAULT_TEMPLATE };
