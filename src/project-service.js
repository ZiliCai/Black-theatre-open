// Glue between the page and the project / document modules. No Electron here: the config store and the
// recycle bin are passed in, so the whole thing can be tested with a temp folder.
const fs = require('node:fs');
const path = require('node:path');
const P = require('./projects');
const D = require('./docs');
const { dirStats } = require('./dirs');
const { resolveInside, sameDir } = require('./safe-path');

const NO_PROJECT = { ok: false, noProject: true, message: '还没有选择剧本项目。先在「项目」页新建或切换一个' };

function createProjectService({ getConfig, setConfig, trash, now = () => new Date() }) {
  // The active project, or null when there is none (or its folder is gone).
  function current() {
    const dir = getConfig().activeProject;
    if (!dir || !fs.existsSync(dir)) return null;
    const read = P.readProject(dir, { now });
    if (!read.ok) return null;
    return { dir, project: read.project, paths: P.projectPaths(dir, read.project) };
  }

  const withProject = (fn) => {
    const c = current();
    return c ? fn(c) : NO_PROJECT;
  };

  // The config change for "now using this project", also remembering it in the known list.
  function useProject(dir) {
    const sw = P.switchPatch(dir);
    if (!sw.ok) return sw;
    return { ok: true, patch: { ...sw.patch, projects: P.addKnown(getConfig().projects, dir) }, message: '' };
  }

  // ---------- projects ----------
  async function list() {
    const config = getConfig();
    const projects = await Promise.all(P.describeProjects(config).map(async (p) => ({
      ...p,
      stats: p.exists ? await dirStats(p.dir, { maxFiles: 20000, maxMs: 500 }) : null,
    })));
    const missing = !!config.activeProject && !fs.existsSync(config.activeProject);
    return { ok: true, root: config.projectsRoot, projects, activeProject: config.activeProject || '', activeMissing: missing };
  }

  async function create({ name, activate = true }) {
    const made = P.createProject({ root: getConfig().projectsRoot, name, now });
    if (!made.ok) return made;
    return finishAdd(made.dir, activate);
  }

  function finishAdd(dir, activate) {
    const known = { projects: P.addKnown(getConfig().projects, dir) };
    if (!activate) {
      setConfig(known);
      return { ok: true, dir, activated: false, message: '' };
    }
    const use = useProject(dir);
    if (!use.ok) { // the project exists, only the switch failed
      setConfig(known);
      return { ok: true, dir, activated: false, warning: use.message, message: '' };
    }
    setConfig(use.patch);
    return { ok: true, dir, activated: true, message: '' };
  }

  async function inspectImport(dir) {
    return P.inspectFolder(dir);
  }

  async function importFolder({ dir, docsDir, activate = true }) {
    const r = P.importProject({ dir, docsDir, now });
    if (!r.ok) return r;
    return { ...finishAdd(dir, activate), created: r.created, repaired: r.repaired };
  }

  async function switchTo(dir) {
    const use = useProject(dir);
    if (!use.ok) return use;
    setConfig(use.patch);
    return { ok: true, dir, message: '' };
  }

  async function leave() {
    setConfig(P.clearPatch());
    return { ok: true, message: '' };
  }

  async function forget(dir) {
    const config = getConfig();
    const patch = { projects: P.removeKnown(config.projects, dir) };
    if (config.activeProject && sameDir(config.activeProject, dir)) Object.assign(patch, P.clearPatch());
    setConfig(patch);
    return { ok: true, message: '' };
  }

  async function rename(dir, name) {
    return P.renameProject(dir, name);
  }

  // ---------- documents ----------
  async function docsList() {
    return withProject(({ dir, project, paths }) => {
      const r = D.listDocs(paths.docs, project);
      return { ok: true, exists: r.exists, docs: r.docs, folderName: project.docsDir, categories: P.CATEGORIES, project: { dir, name: project.name } };
    });
  }

  const docsRead = async (relPath) => withProject(({ paths }) => D.readDoc(paths.docs, relPath));

  const docsSave = async ({ relPath, content, version, overwrite }) =>
    withProject(({ paths }) => D.saveDoc({ docsDir: paths.docs, relPath, content, expectVersion: version, overwrite: !!overwrite, now }));

  async function docsCreate({ name, category }) {
    return withProject(({ dir, paths }) => {
      const r = D.createDoc({ docsDir: paths.docs, name });
      if (!r.ok) return r;
      const cat = P.CATEGORIES.includes(category) ? category : D.guessCategory(r.relPath);
      P.setDocCategory(dir, r.relPath, cat);
      return { ok: true, relPath: r.relPath, category: cat, message: '' };
    });
  }

  async function docsRename({ relPath, name }) {
    return withProject(({ dir, paths }) => {
      const r = D.renameDoc({ docsDir: paths.docs, relPath, newName: name });
      if (r.ok) P.moveDocKey(dir, relPath, r.relPath);
      return r;
    });
  }

  async function docsSetCategory({ relPath, category }) {
    return withProject(({ dir }) => P.setDocCategory(dir, relPath, category));
  }

  async function docsTrash({ relPath }) {
    const c = current();
    if (!c) return NO_PROJECT;
    const r = await D.trashDoc({ docsDir: c.paths.docs, relPath, trash });
    if (r.ok) P.dropDocKey(c.dir, relPath);
    return r;
  }

  const docsHistory = async (relPath) => withProject(({ paths }) => ({ ok: true, history: D.listHistory(paths.docs, relPath) }));
  const docsHistoryRead = async (relPath, id) => withProject(({ paths }) => D.readHistory(paths.docs, relPath, id));
  const docsSearch = async (query) => withProject(({ paths }) => ({ ok: true, results: D.searchDocs(paths.docs, query) }));

  async function docsEnsureFolder() {
    return withProject(({ paths }) => {
      try {
        fs.mkdirSync(paths.docs, { recursive: true });
        return { ok: true, message: '' };
      } catch (e) {
        return { ok: false, message: `无法创建文件夹:${e.message}` };
      }
    });
  }

  async function docsSetFolder(absPath) {
    return withProject(({ dir }) => {
      const rel = typeof absPath === 'string' && absPath ? path.relative(dir, absPath) : '';
      if (!rel || !resolveInside(dir, rel)) return { ok: false, message: '设定文件夹必须是项目文件夹里面的一个子文件夹' };
      return P.setDocsDir(dir, rel.split(path.sep).join('/'));
    });
  }

  async function docsFolderPath() {
    const c = current();
    return c ? c.paths.docs : null;
  }

  async function docsFilePath(relPath) {
    const c = current();
    return c && /\.(md|txt)$/i.test(String(relPath)) ? resolveInside(c.paths.docs, relPath) : null;
  }

  return {
    list, create, inspectImport, importFolder, switchTo, leave, forget, rename,
    docsList, docsRead, docsSave, docsCreate, docsRename, docsSetCategory, docsTrash,
    docsHistory, docsHistoryRead, docsSearch, docsEnsureFolder, docsSetFolder, docsFolderPath, docsFilePath,
  };
}

module.exports = { createProjectService };
