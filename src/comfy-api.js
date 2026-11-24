// Talks to a ComfyUI over plain HTTP. Uses Node's http module with its own agent so requests go straight to
// 127.0.0.1 and never through HTTP_PROXY / the system proxy. A remote ComfyUI is reached the same way, through
// the SSH tunnel's local port.
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');

// "<subfolder>/<name>" inside ComfyUI's output folder, as the /view and /upload endpoints want it
function splitOutputPath(rel) {
  const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  const at = clean.lastIndexOf('/');
  return at < 0 ? { subfolder: '', filename: clean } : { subfolder: clean.slice(0, at), filename: clean.slice(at + 1) };
}

const viewPath = (rel, type = 'output') => {
  const { subfolder, filename } = splitOutputPath(rel);
  return `/view?${new URLSearchParams({ filename, subfolder, type })}`;
};

function createApi({ port, host = '127.0.0.1', timeoutMs = 2500 }) {
  const agent = new http.Agent({ keepAlive: false });

  // One request. body is a JSON value, or { raw: Buffer, type } for anything else; toFile streams the answer to
  // a file instead of collecting it. Resolves { status, headers, text }.
  function send(method, path, { body, toFile = null, timeout = timeoutMs, okStatus = [200] } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null
        : body && Buffer.isBuffer(body.raw) ? body.raw : Buffer.from(JSON.stringify(body));
      const type = body && Buffer.isBuffer(body.raw) ? body.type : 'application/json';
      const req = http.request(
        {
          host, port, path, method, agent,
          headers: payload ? { 'content-type': type, 'content-length': payload.length } : {},
        },
        (res) => {
          if (!okStatus.includes(res.statusCode)) {
            res.resume();
            const err = new Error(`HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            return reject(err);
          }
          if (toFile) {
            const out = fs.createWriteStream(toFile);
            res.pipe(out);
            out.on('finish', () => resolve({ status: res.statusCode, headers: res.headers, text: '' }));
            out.on('error', reject);
            res.on('error', reject);
            return;
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
      req.setTimeout(timeout, () => req.destroy(new Error(`请求超时(${timeout} ms)`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const request = async (method, path, body) => (await send(method, path, { body })).text;
  const getJson = async (path) => JSON.parse(await request('GET', path));

  return {
    async systemStats() {
      const d = await getJson('/system_stats');
      const dev = (d.devices && d.devices[0]) || null;
      return {
        ramTotal: d.system ? d.system.ram_total : null,
        ramFree: d.system ? d.system.ram_free : null,
        vramTotal: dev ? dev.vram_total : null,
        vramFree: dev ? dev.vram_free : null,
        deviceName: dev ? dev.name : null,
        argv: d.system && Array.isArray(d.system.argv) ? d.system.argv : null,
      };
    },
    async queue() {
      const d = await getJson('/queue');
      return { running: (d.queue_running || []).length, pending: (d.queue_pending || []).length };
    },
    // ids of the prompts ComfyUI is running or still has waiting
    async queuePrompts() {
      const d = await getJson('/queue');
      return [...(d.queue_running || []), ...(d.queue_pending || [])].map((item) => item[1]).filter((id) => typeof id === 'string');
    },
    // takes a prompt that has not started out of ComfyUI's queue
    async forget(promptId) {
      await request('POST', '/queue', { delete: [promptId] });
    },
    async free() {
      await request('POST', '/free', { unload_models: true, free_memory: true });
    },
    // a run is a large request, and through a remote link it can take more than the usual few seconds
    async prompt(graph, { clientId } = {}) {
      return JSON.parse((await send('POST', '/prompt', { body: { prompt: graph, ...(clientId ? { client_id: clientId } : {}) }, timeout: Math.max(timeoutMs, 30000) })).text);
    },
    // the id of the run sent with this client id, if ComfyUI has it running or waiting: a send that timed out on
    // the way back may still have arrived
    async promptByClient(clientId) {
      const d = await getJson('/queue');
      const hit = [...(d.queue_running || []), ...(d.queue_pending || [])].find((item) => item[3] && item[3].client_id === clientId);
      return hit && typeof hit[1] === 'string' ? hit[1] : null;
    },
    async history(promptId) {
      return getJson(`/history/${encodeURIComponent(promptId)}`);
    },
    async interrupt() {
      await request('POST', '/interrupt', {});
    },

    // ---- files and models, for a ComfyUI that does not share this computer's folders ----
    // the model folders ComfyUI knows (loras, vae, ...), and the files in one of them
    async modelFolders() {
      const d = await getJson('/models');
      return Array.isArray(d) ? d.filter((f) => typeof f === 'string') : [];
    },
    async models(folder) {
      const d = await getJson(`/models/${encodeURIComponent(folder)}`);
      return Array.isArray(d) ? d.filter((f) => typeof f === 'string') : [];
    },
    // The continuation pictures in the output folder ("h3_context/x.jpg [output]", newest first), as the H3 Motion
    // Context picker offers them. The run history does not list them, so this is how a remote one is found.
    async contextClips() {
      const d = await getJson('/object_info/MiniMaxH3MotionContextPickLatent');
      const spec = d && d.MiniMaxH3MotionContextPickLatent && d.MiniMaxH3MotionContextPickLatent.input
        && d.MiniMaxH3MotionContextPickLatent.input.required && d.MiniMaxH3MotionContextPickLatent.input.required.clip;
      return Array.isArray(spec) && Array.isArray(spec[0]) ? spec[0].filter((v) => typeof v === 'string') : [];
    },
    // size in bytes of a file in ComfyUI's output folder (or its input folder), or null when it is not there
    async outputSize(rel, type = 'output') {
      try {
        const r = await send('HEAD', viewPath(rel, type), { timeout: 15000 });
        const n = Number(r.headers['content-length']);
        return Number.isFinite(n) ? n : null;
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },
    // puts a local file at <rel> in ComfyUI's output folder (or its input folder), replacing what is there
    async uploadOutput(rel, absPath, type = 'output') {
      const { subfolder, filename } = splitOutputPath(rel);
      const boundary = `----blackbox${crypto.randomBytes(12).toString('hex')}`;
      const field = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
      const raw = Buffer.concat([
        field('type', type),
        field('subfolder', subfolder),
        field('overwrite', 'true'),
        // plain UTF-8 name plus the RFC 5987 form, so a Chinese file name arrives as it is
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        await fs.promises.readFile(absPath),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const r = await send('POST', '/upload/image', { body: { raw, type: `multipart/form-data; boundary=${boundary}` }, timeout: 600000 });
      return JSON.parse(r.text || '{}');
    },
    // copies <rel> from ComfyUI's output folder to a local file
    async downloadOutput(rel, absPath) {
      await send('GET', viewPath(rel), { toFile: absPath, timeout: 600000 });
    },
  };
}

module.exports = { createApi, splitOutputPath };
