// Typed view of window.launcher (preload.js). Shot-page types are exact; older pages use loose records.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Loose = Record<string, any>;
export type Result = { ok: boolean; message?: string; errors?: string[] } & Loose;

export type Tier = '' | 'cand' | 'pick' | 'trash';
export type TakeStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type ContinuationChoice =
  | { mode: 'none' } | { mode: 'previous' } | { mode: 'shot'; shotId: string } | { mode: 'legacy'; legacyShot: string };

export type ShotValues = {
  prompt: string; duration: number; aspect: string; megapixels: number; steps: number;
  seedMode: 'random' | 'fixed'; seed: number | null; references: string[];
  loras: { name: string; strength: number }[]; extensions: Record<string, boolean>;
  turboEnabled?: boolean; turboModel?: string; fullSteps?: number;
};
export type Draft = { templateId: string; values: ShotValues; continuation: ContinuationChoice };
export type Take = {
  id: string; n: number; createdAt: number; status: TakeStatus; tier: Tier; templateId: string;
  values: ShotValues; seed: number | null; outputKey: string; promptId?: string; error: string | null;
  video?: string | null; context?: string | null; durationSec?: number | null;
  continuedFrom: null | { shotId: string; takeId: string } | { legacy: string };
  stale?: '' | 'prev-changed' | 'upstream-changed';
  upscale?: Upscale;
};
// a take's SeedVR2 upscale: the bigger video sits beside the original, which stays as it is
export type Upscale = {
  status: TakeStatus; quality: string; resolution: number; error: string | null;
  video?: string | null; width?: number | null; height?: number | null; durationSec?: number | null;
};
export type ShotRow = { id: string; n: string; title: string; source: 'script' | 'manual' | 'orphan'; status: 'none' | 'cand' | 'pick' | 'running'; duration: number | null; linkNote?: boolean };
// a shot that has to change along with another one to stay joined up, and what to change in it
export type Affect = { shotId: string; n: string; reason: string; remark: string };
// a whitebox scene (src/scene-model.js): plain data, drawn from the boxes the main process works out
export type Scene = Loose & { name: string; code?: string; levelHeight: number; rooms: Loose[]; cameras?: Loose[]; people?: Loose[]; setups?: SceneSetup[] };
export type SceneSetup = Loose & { name: string; room?: string; shots?: string[]; people?: Loose[]; cameras?: Loose[] };
export type SceneBox = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; kind: string; name: string; group: number | 'outdoor'; solid?: boolean; edges?: boolean; floor?: boolean; wall?: boolean; opening?: boolean; furniture?: boolean; room?: string };
// what a floor plan draws besides the boxes: rooms, doors and windows (a piece of wall line), stairs with their flights
export type SceneRect = { x0: number; x1: number; z0: number; z1: number };
export type ScenePlanData = {
  rooms: { name: string; lv: number; x: number[]; z: number[]; outdoor: boolean; wall: string; open: string[] }[];
  openings: { name: string; kind: 'door' | 'window'; lv: number; wall: 'z' | 'x'; at: number; from: number; to: number; sill: number; top: number; room: string; side: string }[];
  stairs: (SceneRect & { name: string; lv: number; room: string; flights: (SceneRect & { y0: number; y1: number; dir: string; steps: number })[]; landing: (SceneRect & { y0: number; y1: number }) | null })[];
};
export type SceneCamera = { name: string; pos: number[]; target: number[]; fov: number; see: string[]; card?: string; shots?: string[]; setup?: string };
export type SceneBuilt = {
  boxes: SceneBox[]; cyls: SceneBox[]; levels: number; levelHeight: number; cameras: SceneCamera[];
  people: { name: string; lv: number; x: number; y: number; z: number; pose?: string; facing?: number[]; setup?: string }[];
  lines: { name: string; from: number[]; to: number[]; radius: number; kind: string }[];
  slopes: { name: string; from: number[]; to: number[]; z: number[]; kind: string }[];
  labels: { text: string; at: number[]; lv: number }[];
  plan?: ScenePlanData;
};
export type SceneProblem = { level: 'error' | 'warn'; where: string; message: string };
export type SceneRow = { id: string; name: string; rooms: number; broken: boolean; mtimeMs: number };
export type SceneProposal = Result & { scene?: Scene; built?: SceneBuilt; note?: string; done?: string[]; failed?: { text: string; message: string }[]; problems?: SceneProblem[]; added?: SceneProblem[]; tries?: number; facts?: Record<string, string>; setup?: SceneSetup; left?: string[] };
export type LinkNote = { from: string; reason: string; remark: string; at: number };
// the script discussion: what the AI is shown, and the conversation with the edits each reply proposed
export type ChatEdit = { id: string; doc: string; find: string; replace: string; why: string; state: 'todo' | 'applied' };
export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; at: number; edits?: ChatEdit[]; shots?: Affect[]; shotsDone?: boolean };
export type BreakdownCard = { code: string; kind: 'char' | 'scene'; name: string; look: string };
export type BreakdownShot = { title: string; duration: number; description: string; cast: string[]; continue: boolean; status?: 'todo' | 'done' | 'failed'; error?: string; prompt?: string; codes?: string[] };
export type BreakdownEpisode = { id: string; title: string; doc?: string; shots: BreakdownShot[] };
export type BreakdownPlan = { style: string; cards: BreakdownCard[]; episodes: BreakdownEpisode[] };
export type BreakdownState = BreakdownPlan & {
  phase: 'planning' | 'review' | 'writing' | 'stopped' | 'done' | 'failed';
  existing: BreakdownCard[]; cardsDoc?: string; error: string; sources: { relPath: string }[];
  progress: { done: number; total: number; label: string } | null;
};
export type Breakdown = Result & { running: '' | 'plan' | 'write'; stopping: boolean; state: BreakdownState | null; docs: { relPath: string; name: string; category: string; chars: number }[]; limit: number };
export type ScriptChat = Result & { docs: { relPath: string; name: string; chars: number; chosen: boolean }[]; chosenChars: number; limit: number; messages: ChatMessage[]; busy: boolean; doc?: string };
export type Episode = { id: string; shots: ShotRow[] };
export type TemplateForm = {
  id: string; name: string; version: string; limits: Loose;
  defaults: ShotValues & { continuationEnabled: boolean; continuationClip: string };
  capabilities: { turbo: boolean; continuation: boolean; loraChain: boolean };
  turboModels: { value: string; label: string; steps: number; desc?: string }[];
  aspects: { id: string; label: string; w: number; h: number }[];
  referenceSlots: { id: string; label: string; picture: string }[];
};
export type ShotDetail = {
  ok: true;
  shot: { id: string; n: string; title: string; episode: string; source: ShotRow['source']; duration: number | null };
  draft: Draft; form: TemplateForm; takes: Take[]; warning: string;
  continuation: {
    supported: boolean; choice: ContinuationChoice;
    resolved: { ok: true; enabled: false } | { ok: true; enabled: true; clip: string; from: Loose } | { ok: false; message: string };
    options: { label: string; choice: ContinuationChoice }[];
  };
  templates: { id: string; name: string; compatible: boolean }[];
  linkNote: LinkNote | null;
  blocking?: string;
};
export type NoProject = { ok: false; noProject?: boolean; message: string };
export type Segment = {
  shotId: string; start: number; duration: number; kind: 'pick' | 'cand' | 'gap'; linked: boolean;
  takeId: string | null; video: string | null; hasCand: boolean; stale: '' | 'prev-changed' | 'upstream-changed';
  upscaled?: string | null;
};
export type Timeline = { ok: true; total: number; segments: Segment[] };
export type QueueJob = { takeId: string; shotId: string; kind?: 'video' | 'image' | 'upscale'; status: string; value: number; max: number;
  // the whole run: progress 0–1 (only moves forward), what it is doing now, time spent and time left of all of it
  progress: number; stage: 'queued' | 'prep' | 'steps' | 'tail' | 'done'; elapsedMs: number; remainingMs: number | null; preview: { data: string; mime: string } | null };
export type QueueSnapshot = { busy: boolean; paused: boolean; message: string; jobs: QueueJob[] };

// asset cards: one per code in the project's people-and-places list
export type PictureTier = '' | 'cand' | 'keep' | 'trash';
export type CardKind = 'char' | 'scene';
export type CardRow = { code: string; kind: CardKind; name: string; orphan: boolean; main: string; kept: number; status: 'empty' | 'ready' | 'busy' };
export type Card = { code: string; kind: CardKind; name: string; description: string; style: string; source: string; orphan?: boolean };
// look/lookFrom: the card's own edit of the list's appearance line and the line it was made from ('' = none)
export type PictureDraft = { mode: 't2i' | 'i2i'; base: string; ask: string; aspect: string; count: number; look: string; lookFrom: string };
export type CardLook = { text: string; edited: boolean; stale: boolean };
export type PictureTake = {
  id: string; n: number; batch: string; createdAt: number; status: TakeStatus; tier: PictureTier; templateId: string;
  mode: 't2i' | 'i2i'; base: string | null; ask: string; prompt: string; aspect: string | null;
  width: number | null; height: number | null; seed: number | null; outputKey: string; error: string | null; image?: string | null;
};
export type KeptPicture = { image: string; label: string; takeId: string | null; addedAt: number; usedBy: string[] };
export type ExistingPicture = { image: string; label: string; source: 'output' | 'ref' | 'input'; relPath: string };
export type CardDetail = {
  ok: true; card: Card; draft: PictureDraft; prompt: string; look: CardLook; takes: PictureTake[]; set: KeptPicture[]; main: string; warning: string;
  aspects: { id: string; label: string; w: number; h: number }[]; appearances: string[]; existing: ExistingPicture[];
};
export type CardSets = { ok: true; cards: { code: string; kind: CardKind; name: string; images: { value: string; label: string; main: boolean }[] }[] };

export type Status = {
  state: string; pid: number | null; message?: string; deviceName?: string | null;
  vramTotal: number | null; vramFree: number | null; ramTotal: number | null; ramFree: number | null;
  queueRunning: number | null; queuePending: number | null; processMemMB?: number | null; dirs?: Loose;
  remote?: boolean; serverName?: string; tunnel?: Tunnel;
};
// remote GPU servers, reached over SSH (src/remote-servers.js)
export type RemoteServer = {
  id: string; name: string; host: string; port: number; user: string; keyFile: string;
  comfyPort: number; startCommand: string; modelSwaps: Record<string, string>;
};
export type Tunnel = { state: 'off' | 'connecting' | 'open' | 'down'; kind: string; message: string; port: number | null; serverId: string; since: number };
export type RemotePayload = { ok: true; target: string; servers: RemoteServer[]; tunnel: Tunnel };
export type ServerTest = { ok: boolean; message?: string; steps: { label: string; ok: boolean; detail: string }[] };
export type Alert = { title: string; sub: string; count?: number } | null;
export type LlmPriceRow = { model: string; hit: [number, number]; miss: [number, number]; out: [number, number] };
export type LlmPrices = { currency: string; offPeak: { start: string; end: string }; models: LlmPriceRow[] };
export type LlmUsageRow = { calls: number; hit: number; miss: number; out: number; reasoning: number; cost: number; unpriced: number };
export type LlmUsage = {
  ok: true; prices: LlmPrices; total: LlmUsageRow; today: LlmUsageRow; month: LlmUsageRow;
  days: (LlmUsageRow & { day: string; model: string })[]; purposes: (LlmUsageRow & { purpose: string })[];
};

type Fn<A, R> = (arg: A) => Promise<R>;
type Bridge = {
  getConfig: Fn<void, Loose>; setConfig: Fn<Loose, Loose>; pickWorkdir: Fn<void, string | null>;
  testLlm: Fn<void, Result>; optimizePrompt: Fn<Loose, Result>;
  llmUsage: Fn<void, LlmUsage>; setLlmPrices: Fn<LlmPrices | null, { ok: boolean; message?: string; prices?: LlmPrices }>;
  start: Fn<void, Result>; stop: Fn<void, Result>; restart: Fn<void, Result>; clearCache: Fn<void, Result>;
  openUI: Fn<void, void>; openLog: Fn<void, void>;
  remoteGet: Fn<void, RemotePayload>; remoteSave: Fn<RemoteServer, (RemotePayload & { saved: string }) | { ok: false; message: string }>;
  remoteDelete: Fn<{ id: string }, RemotePayload | { ok: false; message: string }>;
  remoteUse: Fn<{ id: string }, RemotePayload | { ok: false; message: string }>;
  remoteTest: Fn<RemoteServer, ServerTest>; remoteRetry: Fn<void, RemotePayload>; copyReport: Fn<void, Result>; dismissAlert: Fn<void, Result>;
  getDirs: Fn<void, Loose>; pickDir: Fn<{ which: string }, string | null>; setDir: Fn<{ which: string; path: string }, Result>; openDir: Fn<{ which: string }, Result>;
  getModels: Fn<{ force?: boolean } | void, Loose>; revealModel: Fn<{ relPath: string }, Result>;
  getWorkflowForm: Fn<void, Loose>; listWorkflowTemplates: Fn<void, Loose>; setWorkflowTemplate: Fn<{ id: string }, Result>;
  importWorkflowShot: Fn<{ shotId: string }, Result>; reviseWorkflowPrompt: Fn<{ text: string; feedback: string; tidyOnly?: boolean; aroundShotId?: string; context?: { references: string[]; duration?: number; width?: number; height?: number; continuation?: boolean }; shotId?: string }, Result>;
  previewWorkflow: Fn<Loose, Result>; startWorkflow: Fn<Loose, Result>; getWorkflowRun: Fn<void, Loose>; cancelWorkflow: Fn<void, Result>;
  getGallery: Fn<{ root?: string } | void, Loose>; pickGalleryRoot: Fn<void, string | null>; trashGallery: Fn<{ relPaths: string[] }, Result>;
  revealGallery: Fn<{ relPath: string }, Result>; openGalleryRoot: Fn<void, Result>; copyText: Fn<{ text: string }, Result>;
  planClipSync: Fn<{ includeSlots?: boolean }, Loose>; trashClips: Fn<{ stems: string[]; includeSlots?: boolean }, Result>;
  keepTake: Fn<{ relPath: string; shot: string }, Result>; unkeepTake: Fn<{ relPath: string }, Result>;
  listProjects: Fn<void, Loose>; createProject: Fn<{ name: string; activate?: boolean }, Result>; inspectProject: Fn<{ dir: string }, Loose>;
  importProject: Fn<{ dir: string; docsDir?: string; activate?: boolean }, Result>; pickProjectFolder: Fn<void, string | null>;
  switchProject: Fn<{ dir: string }, Result>; leaveProject: Fn<void, Result>; forgetProject: Fn<{ dir: string }, Result>;
  renameProject: Fn<{ dir: string; name: string }, Result>; openProject: Fn<{ dir: string }, Result>;
  listDocs: Fn<void, Loose>; readDoc: Fn<{ relPath: string }, Loose>; saveDoc: Fn<Loose, Result>; createDoc: Fn<Loose, Result>;
  renameDoc: Fn<Loose, Result>; setDocCategory: Fn<Loose, Result>; trashDoc: Fn<{ relPath: string }, Result>;
  docHistory: Fn<{ relPath: string }, Loose>; readDocHistory: Fn<{ relPath: string; id: string }, Loose>; searchDocs: Fn<{ query: string }, Loose>;
  ensureDocsFolder: Fn<void, Result>; pickDocsFolder: Fn<void, Result>; revealDoc: Fn<{ relPath?: string }, Result>;
  shotEpisodes: Fn<void, { ok: true; episodes: Episode[]; warnings: string[] } | NoProject>;
  shotDetail: Fn<{ shotId: string }, ShotDetail | NoProject>;
  saveShotDraft: Fn<{ shotId: string; draft: Draft }, Result>;
  writeShotPrompt: Fn<{ shotId: string; expected: string; prompt: string }, Result>;
  enqueueTakes: Fn<{ shotId: string; count: number }, Result & { takeIds?: string[] }>;
  setTakeTier: Fn<{ shotId: string; takeId: string; tier: Tier }, Result>;
  // place: right before / after the shot `anchor`, or at the end of the episode
  createManualShot: Fn<{ episode: string; title: string; anchor: string | null; place: 'before' | 'after' | 'end' }, Result & { id?: string; notice?: string }>;
  // the AI writes the new shot's prompt and settings from a few words, then it is made like a hand-made one
  composeShot: Fn<{ episode: string; title: string; anchor: string | null; place: 'before' | 'after' | 'end'; description: string }, Result & { id?: string; notice?: string; note?: string; warnings?: string[] }>;
  // asks first (a dialog), then takes the shot off the episode; next: the shot to show instead
  deleteShot: Fn<{ shotId: string }, Result & { cancelled?: boolean; next?: string }>;
  shotTimeline: Fn<{ episode: string; gapMode: 'black' | 'cand' | 'skip' }, Timeline | NoProject>;
  reviseLinkedShot: Fn<{ shotId: string; remark: string }, Result & { note?: string; affects?: Affect[] }>;
  fitBlocking: Fn<{ shotId: string }, Result & { note?: string; warnings?: string[]; affects?: Affect[] }>;
  noteLinkedShot: Fn<{ shotId: string; from: string; reason: string; remark: string }, Result>;
  clearLinkedShot: Fn<{ shotId: string }, Result>;
  loadScriptChat: Fn<void, ScriptChat>;
  setScriptChatDocs: Fn<{ relPaths: string[] }, ScriptChat>;
  sendScriptChat: Fn<{ text: string }, ScriptChat>;
  applyScriptChatEdit: Fn<{ messageId: string; editId: string }, ScriptChat>;
  undoScriptChatEdit: Fn<{ messageId: string; editId: string }, ScriptChat>;
  scriptChatShotsDone: Fn<{ messageId: string }, ScriptChat>;
  clearScriptChat: Fn<void, ScriptChat>;
  loadBreakdown: Fn<void, Breakdown>;
  startBreakdown: Fn<{ relPaths: string[] }, Breakdown>;
  updateBreakdown: Fn<{ plan: BreakdownPlan }, Breakdown>;
  writeBreakdown: Fn<void, Breakdown>;
  stopBreakdown: Fn<void, Breakdown>;
  discardBreakdown: Fn<void, Breakdown>;
  sceneList: Fn<void, Result & { scenes?: SceneRow[]; folder?: string; noProject?: boolean }>;
  sceneOpen: Fn<{ id: string }, Result & { id?: string; scene?: Scene; version?: string; built?: SceneBuilt; problems?: SceneProblem[]; broken?: boolean; text?: string }>;
  sceneBuild: Fn<{ scene: Scene; setup?: string }, Result & { built: SceneBuilt; problems: SceneProblem[]; facts?: Record<string, string> }>;
  sceneBlock: Fn<{ scene: Scene; name: string; room: string; shots: string; remark?: string }, SceneProposal>;
  sceneCreate: Fn<{ name: string }, Result & { id?: string; version?: string }>;
  sceneSave: Fn<{ id: string; scene: Scene; version: string; overwrite?: boolean }, Result & { version?: string; conflict?: boolean }>;
  sceneShot: Fn<{ id: string; index: number; camera: string; dataUrl: string }, Result & { relPath?: string }>;
  sceneEdit: Fn<{ scene: Scene; remark: string; focus?: string }, SceneProposal>;
  sceneFurnish: Fn<{ scene: Scene; room: string; remark?: string; docs?: string[] }, SceneProposal>;
  sceneGenerate: Fn<{ name: string; docs: string[]; remark?: string }, Result & { id?: string; skipped?: string[] }>;
  onSceneProgress: (cb: (p: { step: string; done: number; total: number; text: string }) => void) => () => void;
  upscaleOptions: Fn<void, { ok: true; qualities: string[]; all: string[]; defaultQuality: string }>;
  upscaleTake: Fn<{ shotId: string; takeId: string; quality: string }, Result & { queued?: number }>;
  upscaleEpisode: Fn<{ episode: string; quality: string }, Result & { queued?: number; skipped?: number }>;
  assetCards: Fn<void, { ok: true; cards: CardRow[]; warnings: string[]; sources: string[]; message: string } | NoProject>;
  assetDetail: Fn<{ code: string }, CardDetail | NoProject>;
  saveAssetDraft: Fn<{ code: string; draft: PictureDraft }, Result & { prompt?: string; look?: CardLook }>;
  reviseAssetAsk: Fn<{ code: string; ask: string; look: string; mode: PictureDraft['mode']; feedback: string; tidyOnly?: boolean }, Result & { ask?: string; look?: string; note?: string; warnings?: string[]; affects?: Affect[] }>;
  enqueuePictures: Fn<{ code: string; count: number }, Result & { takeIds?: string[] }>;
  setPictureTier: Fn<{ code: string; takeId: string; tier: PictureTier; label?: string }, Result>;
  setMainPicture: Fn<{ code: string; image: string }, Result>;
  relabelPicture: Fn<{ code: string; image: string; label: string }, Result>;
  unkeepPicture: Fn<{ code: string; image: string }, Result>;
  adoptPicture: Fn<{ code: string; relPath: string }, Result>;
  assetSets: Fn<void, CardSets | NoProject>;
  queueSnapshot: Fn<void, QueueSnapshot>; cancelTake: Fn<{ takeId: string }, Result>; cancelAllTakes: Fn<void, Result>; retryQueue: Fn<void, Result>;
  onStatus: (cb: (s: Status) => void) => () => void;
  onAlert: (cb: (a: Alert) => void) => () => void;
  onQueue: (cb: (q: QueueSnapshot) => void) => () => void;
  onNotice: (cb: (n: { message: string }) => void) => () => void;
};

declare global {
  interface Window { launcher: Bridge }
}

export const api: Bridge = window.launcher;

// media:// URLs: 'project' serves the active project's output folder, 'local' the folder the 成片 page browses,
// 'workflow' the output folder used for reference pictures.
export const mediaUrl = (host: 'project' | 'local' | 'workflow', relPath: string) =>
  `media://${host}/${relPath.split('/').map(encodeURIComponent).join('/')}`;
