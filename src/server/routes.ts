import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { saveSettings, validateSettings } from '@/src/core/config';
import { DirError, listDirs } from '@/src/core/dirs';
import { deleteSession } from '@/src/core/purge';
import { inside } from '@/src/core/paths';
import { agentMetrics, globalMetrics, type AgentMetrics } from '@/src/core/metrics';
import { gitInfo, gitInit } from '@/src/git/git';
import { handleMcp } from '@/src/orchestrator/mcp';
import { maskProjects, unmaskProjects } from '@/src/preview/config';
import { OrchestratorError, type FeedbackImage } from '@/src/orchestrator/orchestrator';
import { FEEDBACK_EXT, FEEDBACK_FILE, FEEDBACK_IMAGE_BYTES, FEEDBACK_IMAGES_MAX } from '@/src/tickets/model';

/** Body góp ý: tối đa FEEDBACK_IMAGES_MAX ảnh base64 (×4/3) cộng phần chữ. */
const FEEDBACK_BODY_MAX = Math.ceil(FEEDBACK_IMAGES_MAX * FEEDBACK_IMAGE_BYTES * 4 / 3) + 1_000_000;
import type { AgentKind, Effort, Plan, Role, Ticket } from '@/src/tickets/model';
import type { Core } from './core';

const HOUR_MS = 3600_000;
const GUARD_BODY_MAX = 32_000_000; // input của Write có thể chứa cả file
const STOP_REASON = 'người dùng dừng';
const ROLES: Role[] = ['controller', 'explorer', 'dev', 'designer', 'qc'];
const AGENTS: AgentKind[] = ['claude', 'codex'];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const AGENT_ID = /^acctv:(T-\d+):([a-z]+-\d+)$/;
const CAPTURE_FILE = /^\d+-[\w-]{1,40}\.png$/;

export class HttpError extends Error {
  constructor(public status: number, msg: string, public extra: Record<string, unknown> = {}) {
    super(msg);
  }
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function originAllowed(origin: string | undefined, port: number): boolean {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function liveMetrics(core: Core, now: number) {
  return globalMetrics(
    core.store.listAgents({ since: now - core.cfg.backfillHours * HOUR_MS }),
    core.store.recentCalls(now - HOUR_MS),
    core.store.activeAlerts(),
    now,
  );
}

/** Body JSON của request; body rỗng là `{}`. Lỗi parse → 400, quá `limitBytes` → 413. */
export function readJson(req: http.IncomingMessage, limitBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tooBig = (): void => {
      const err = new HttpError(413, `body vượt quá ${limitBytes} byte`);
      // đọc bỏ hết phần còn lại rồi mới trả lời: trả 413 rồi đóng kết nối khi client còn đang gửi thì client nhận ECONNRESET/EPIPE thay vì 413
      if (req.complete) return reject(err);
      req.on('end', () => reject(err));
      req.on('close', () => reject(err));
      req.resume();
    };
    if (Number(req.headers['content-length'] ?? 0) > limitBytes) return tooBig();
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size <= limitBytes) return void chunks.push(c);
      over = true;
      req.off('data', onData);
      tooBig();
    };
    req.on('data', onData);
    req.on('error', (e) => reject(new HttpError(400, `lỗi đọc body: ${e.message}`)));
    req.on('end', () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'body không phải JSON hợp lệ'));
      }
    });
  });
}

// ---------- validate ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function objBody(v: unknown): Record<string, unknown> {
  if (!isObj(v)) throw new HttpError(400, 'body phải là object JSON');
  return v;
}

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new HttpError(400, `${field} phải là chuỗi 1–${max} ký tự`);
  return v.trim();
}

const WIN = process.platform === 'win32';

/** Đường dẫn tuyệt đối; trên Windows phải có ổ đĩa (`D:\…`), không nhận `\foo` hay UNC. */
function absDir(v: unknown): string {
  const ok = typeof v === 'string' && !!v && (WIN ? /^[A-Za-z]:[\\/]/.test(v) : path.isAbsolute(v));
  if (!ok) throw new HttpError(400, WIN ? 'dir phải là đường dẫn tuyệt đối có ổ đĩa (vd. D:\\du-an)' : 'dir phải là đường dẫn tuyệt đối');
  return path.resolve(v as string);
}

function overrides(v: unknown, core: Core): Ticket['overrides'] {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new HttpError(400, 'overrides phải là object');
  const s = core.cfg.settings;
  const errors: string[] = [];
  const out: Ticket['overrides'] = {};
  for (const [role, o] of Object.entries(v)) {
    if (!ROLES.includes(role as Role)) { errors.push(`overrides.${role}: vai không hợp lệ`); continue; }
    if (!isObj(o)) { errors.push(`overrides.${role}: phải là object`); continue; }
    const r = role as Role;
    const spec: NonNullable<Ticket['overrides'][Role]> = {};
    if (o.agent !== undefined) {
      if (r === 'controller' && o.agent === 'codex') errors.push('overrides.controller.agent: Controller luôn là claude');
      else if (AGENTS.includes(o.agent as AgentKind)) spec.agent = o.agent as AgentKind;
      else errors.push(`overrides.${r}.agent: phải là claude hoặc codex`);
    }
    if (o.effort !== undefined) {
      if (EFFORTS.includes(o.effort as Effort)) spec.effort = o.effort as Effort;
      else errors.push(`overrides.${r}.effort: phải là ${EFFORTS.join(', ')}`);
    }
    if (o.model !== undefined) {
      const agent = spec.agent ?? s.roleDefaults[r].agent;
      if (typeof o.model === 'string' && (s.allowedModels[agent] ?? []).includes(o.model)) spec.model = o.model;
      else errors.push(`overrides.${r}.model: "${String(o.model)}" không nằm trong danh sách cho phép của ${agent}`);
    }
    if (Object.keys(spec).length) out[r] = spec;
  }
  if (errors.length) throw new HttpError(400, errors.join('\n'), { errors });
  return out;
}

function bearer(req: http.IncomingMessage): string {
  return /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
}

// ---------- routes ----------

interface Ctx { req: http.IncomingMessage; url: URL; core: Core; params: string[] }
interface Reply { status: number; json?: unknown; body?: Buffer; contentType?: string }
interface Route { method: 'GET' | 'POST' | 'PUT'; re: RegExp; run(c: Ctx): Promise<Reply> | Reply }

const ok = (json: unknown, status = 200): Reply => ({ status, json });

function intParam(v: string | null, def: number, min: number, max: number, msg: string): number {
  if (v === null) return def;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < min || n > max) throw new HttpError(400, msg);
  return n;
}

/** Settings gửi cho UI: mật khẩu tài khoản test luôn bị che. */
function publicSettings(core: Core) {
  return { settings: { ...core.cfg.settings, projects: maskProjects(core.cfg.settings.projects) }, thresholds: core.cfg.thresholds };
}

function mustTicket(core: Core, id: string): Ticket {
  const t = core.tickets.getTicket(id);
  if (!t) throw new HttpError(404, `Không tìm thấy ticket ${id}`);
  return t;
}

const ROUTES: Route[] = [
  {
    method: 'GET', re: /^\/api\/snapshot$/,
    run: ({ core }) => {
      const now = Date.now();
      const since = now - core.cfg.backfillHours * HOUR_MS;
      const agents = core.store.listAgents({ since });
      const agentM: Record<string, AgentMetrics> = {};
      for (const a of agents) agentM[a.id] = agentMetrics(a, core.store.listCalls(a.id, { limit: 2000 }), now);
      return ok({
        generatedAt: now, agents, alerts: core.store.activeAlerts(),
        metrics: liveMetrics(core, now), agentMetrics: agentM,
        tickets: core.tickets.listTickets(), managed: core.tickets.listManaged(), waits: core.tickets.listWaits(since),
        prices: core.cfg.settings.prices,
        previews: Object.fromEntries(core.tickets.listTickets().flatMap((t) => {
          const p = core.orchestrator.previewStatus(t.id);
          return p ? [[t.id, p]] : [];
        })),
      });
    },
  },
  {
    method: 'GET', re: /^\/api\/agents\/([^/]+)\/calls$/,
    run: ({ core, url, params: [id] }) => {
      const limit = intParam(url.searchParams.get('limit'), 500, 1, 2000, 'limit must be an integer 1..2000');
      const since = intParam(url.searchParams.get('since'), 0, 0, Number.MAX_SAFE_INTEGER, 'since must be a non-negative integer (ms)');
      if (!core.store.getAgent(id)) throw new HttpError(404, 'agent not found');
      return ok(core.store.listCalls(id, { since, limit }));
    },
  },
  { method: 'GET', re: /^\/api\/tickets$/, run: ({ core }) => ok(core.tickets.listTickets()) },
  {
    method: 'POST', re: /^\/api\/tickets$/,
    run: async ({ req, core }) => {
      const b = objBody(await readJson(req));
      const title = text(b.title, 'title', 200);
      if (b.description !== undefined && typeof b.description !== 'string') throw new HttpError(400, 'description phải là chuỗi');
      const dir = absDir(b.dir);
      const ov = overrides(b.overrides, core);
      return ok(await core.orchestrator.createTicket({ title, description: (b.description as string | undefined) ?? '', dir, overrides: ov }), 201);
    },
  },
  {
    method: 'GET', re: /^\/api\/tickets\/([^/]+)$/,
    run: ({ core, params: [id] }) => ok({ ticket: mustTicket(core, id), agents: core.tickets.listManaged(id), log: core.tickets.listLog(id), preview: core.orchestrator.previewStatus(id) }),
  },
  {
    method: 'POST', re: /^\/api\/tickets\/([^/]+)\/preview\/stop$/,
    run: async ({ core, params: [id] }) => {
      mustTicket(core, id);
      await core.orchestrator.stopPreview(id);
      return ok({ ok: true });
    },
  },
  {
    // ảnh capture của một agent, mới nhất trước
    method: 'GET', re: /^\/api\/agents\/([^/]+)\/captures$/,
    run: ({ core, params: [id] }) => {
      const m = AGENT_ID.exec(id);
      if (!m) throw new HttpError(404, 'agent không hợp lệ');
      const dir = path.join(core.cfg.home, 'runs', m[1], m[2], 'captures');
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir).filter((f) => CAPTURE_FILE.test(f));
      } catch {
        names = [];
      }
      const items = names.map((name) => {
        let at = 0;
        try { at = fs.statSync(path.join(dir, name)).mtimeMs; } catch { /* vừa bị xoá */ }
        return { name, file: `/api/captures/${m[1]}/${m[2]}/${name}`, at: Math.round(at) };
      });
      items.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name, undefined, { numeric: true }));
      return ok(items);
    },
  },
  {
    method: 'GET', re: /^\/api\/captures\/([^/]+)\/([^/]+)\/([^/]+)$/,
    run: ({ core, params: [ticket, slot, file] }) => {
      if (!/^T-\d+$/.test(ticket) || !/^[a-z]+-\d+$/.test(slot) || !CAPTURE_FILE.test(file)) throw new HttpError(404, 'not found');
      const runs = path.join(core.cfg.home, 'runs');
      const abs = path.join(runs, ticket, slot, 'captures', file);
      if (!inside(abs, runs)) throw new HttpError(404, 'not found');
      let body: Buffer;
      try { body = fs.readFileSync(abs); } catch { throw new HttpError(404, 'not found'); }
      return { status: 200, body, contentType: 'image/png' };
    },
  },
  {
    method: 'POST', re: /^\/api\/projects\/reset-db$/,
    run: async ({ req, core }) => ok(await core.orchestrator.resetProjectDb(absDir(objBody(await readJson(req)).dir))),
  },
  {
    method: 'POST', re: /^\/api\/tickets\/([^/]+)\/approve$/,
    run: async ({ req, core, params: [id] }) => {
      const b = objBody(await readJson(req));
      return ok(await core.orchestrator.approve(id, b.plan === undefined || b.plan === null ? undefined : (b.plan as Plan)));
    },
  },
  {
    method: 'POST', re: /^\/api\/tickets\/([^/]+)\/revise$/,
    run: async ({ req, core, params: [id] }) => ok(await core.orchestrator.revise(id, text(objBody(await readJson(req)).feedback, 'feedback', 5000))),
  },
  { method: 'POST', re: /^\/api\/tickets\/([^/]+)\/cancel$/, run: async ({ core, params: [id] }) => ok(await core.orchestrator.cancel(id)) },
  {
    method: 'POST', re: /^\/api\/tickets\/([^/]+)\/continue$/,
    run: async ({ req, core, params: [id] }) => ok(await core.orchestrator.continueTicket(id, text(objBody(await readJson(req)).guidance, 'guidance', 5000))),
  },
  {
    // xoá hẳn ticket/phiên; dryRun: chỉ liệt kê những gì sẽ mất để hỏi xác nhận
    method: 'POST', re: /^\/api\/delete$/,
    run: async ({ req, core }) => {
      const b = objBody(await readJson(req));
      const ids = (v: unknown, field: string): string[] => {
        if (v === undefined) return [];
        if (!Array.isArray(v) || v.length > 500 || !v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 200)) {
          throw new HttpError(400, `${field} phải là mảng tối đa 500 id`);
        }
        return [...new Set(v as string[])];
      };
      const tickets = ids(b.tickets, 'tickets');
      const sessions = ids(b.sessions, 'sessions');
      const dryRun = b.dryRun === true;
      const items = [];
      for (const id of tickets) items.push(await core.orchestrator.deleteTicket(id, dryRun));
      for (const id of sessions) items.push(deleteSession(core, id, dryRun));
      return ok({ items });
    },
  },
  { method: 'POST', re: /^\/api\/tickets\/([^/]+)\/remove-worktree$/, run: async ({ core, params: [id] }) => ok(await core.orchestrator.removeWorktree(id)) },
  {
    // góp ý cho ticket đã xong: { text, images: [{ name, type, data (base64) }] }
    method: 'POST', re: /^\/api\/tickets\/([^/]+)\/feedback$/,
    run: async ({ req, core, params: [id] }) => {
      const b = objBody(await readJson(req, FEEDBACK_BODY_MAX));
      if (b.text !== undefined && typeof b.text !== 'string') throw new HttpError(400, 'text phải là chuỗi');
      const raw = b.images ?? [];
      if (!Array.isArray(raw)) throw new HttpError(400, 'images phải là mảng');
      if (raw.length > FEEDBACK_IMAGES_MAX) throw new HttpError(400, `Tối đa ${FEEDBACK_IMAGES_MAX} ảnh mỗi lần góp ý`);
      const images: FeedbackImage[] = raw.map((im, i) => {
        if (!isObj(im) || typeof im.type !== 'string' || typeof im.data !== 'string') throw new HttpError(400, `images[${i}] phải là { name, type, data }`);
        const name = typeof im.name === 'string' && im.name.trim() ? im.name.trim().slice(0, 200) : `ảnh ${i + 1}`;
        return { name, type: im.type, data: Buffer.from(im.data, 'base64') };
      });
      return ok(await core.orchestrator.feedback(id, (b.text as string | undefined) ?? '', images));
    },
  },
  { method: 'GET', re: /^\/api\/tickets\/([^/]+)\/feedback-history$/, run: ({ core, params: [id] }) => (mustTicket(core, id), ok(core.tickets.listFeedback(id))) },
  {
    method: 'GET', re: /^\/api\/tickets\/([^/]+)\/feedback-images\/([^/]+)$/,
    run: ({ core, params: [ticket, file] }) => {
      if (!/^T-\d+$/.test(ticket) || !FEEDBACK_FILE.test(file)) throw new HttpError(404, 'not found');
      const runs = path.join(core.cfg.home, 'runs');
      const abs = path.join(runs, ticket, 'feedback', file);
      if (!inside(abs, runs)) throw new HttpError(404, 'not found');
      let body: Buffer;
      try { body = fs.readFileSync(abs); } catch { throw new HttpError(404, 'not found'); }
      const ext = path.extname(file);
      const type = Object.keys(FEEDBACK_EXT).find((k) => FEEDBACK_EXT[k] === ext) ?? 'application/octet-stream';
      return { status: 200, body, contentType: type };
    },
  },
  { method: 'GET', re: /^\/api\/tickets\/([^/]+)\/merge-targets$/, run: async ({ core, params: [id] }) => ok(await core.orchestrator.mergeTargets(id)) },
  {
    method: 'POST', re: /^\/api\/tickets\/([^/]+)\/merge$/,
    run: async ({ req, core, params: [id] }) => {
      const b = objBody(await readJson(req));
      const mode = b.mode ?? 'commit';
      if (mode !== 'commit' && mode !== 'squash') throw new HttpError(400, 'mode phải là commit hoặc squash');
      return ok(await core.orchestrator.mergeTicket(id, text(b.target, 'target', 255), mode));
    },
  },
  {
    method: 'POST', re: /^\/api\/agents\/([^/]+)\/stop$/,
    run: async ({ core, params: [id] }) => {
      await core.orchestrator.stopAgent(id, STOP_REASON);
      return ok({ ok: true }, 202);
    },
  },
  {
    // người dùng trả lời request_user_action: done=true đã làm xong, false không làm được
    method: 'POST', re: /^\/api\/agents\/([^/]+)\/user-action$/,
    run: async ({ req, core, params: [id] }) => {
      const b = objBody(await readJson(req));
      if (typeof b.done !== 'boolean') throw new HttpError(400, 'done phải là true hoặc false');
      if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > 2000)) {
        throw new HttpError(400, 'note phải là chuỗi tối đa 2000 ký tự');
      }
      const note = typeof b.note === 'string' ? b.note.trim() : '';
      return ok(await core.orchestrator.answerUserAction(id, { done: b.done, note }));
    },
  },
  {
    method: 'GET', re: /^\/api\/fs\/dirs$/,
    run: ({ url }) => {
      const d = url.searchParams.get('dir');
      try { return ok(listDirs(d === null || d === '' ? null : absDir(d))); }
      catch (e) { throw e instanceof DirError ? new HttpError(e.status, e.message) : e; }
    },
  },
  { method: 'GET', re: /^\/api\/fs\/check$/,run: async ({ url }) => ok(await gitInfo(absDir(url.searchParams.get('dir') ?? undefined))) },
  {
    method: 'POST', re: /^\/api\/fs\/git-init$/,
    run: async ({ req, core }) => {
      const dir = absDir(objBody(await readJson(req)).dir);
      let isDir = false;
      try { isDir = fs.statSync(dir).isDirectory(); } catch { /* không tồn tại */ }
      if (!isDir) throw new HttpError(400, 'Thư mục không tồn tại');
      const { home, claudeDir, codexDir } = core.cfg;
      if ([home, claudeDir, codexDir].some((r) => inside(dir, r))) {
        throw new HttpError(400, 'Không được git init trong thư mục của dashboard, Claude hoặc Codex');
      }
      if ((await gitInfo(dir)).isGit) throw new HttpError(409, 'Thư mục đã là git repo');
      await gitInit(dir);
      return ok(await gitInfo(dir));
    },
  },
  { method: 'GET', re: /^\/api\/settings$/, run: ({ core }) => ok(publicSettings(core)) },
  {
    method: 'PUT', re: /^\/api\/settings$/,
    run: async ({ req, core }) => {
      const v = validateSettings(await readJson(req));
      if (!v.ok) throw new HttpError(400, v.errors.join('\n'), { errors: v.errors });
      // mật khẩu hiện dạng che trên UI: giữ mật khẩu cũ khi người dùng không đổi
      const u = unmaskProjects(v.settings.projects, core.cfg.settings.projects);
      if (!u.ok) throw new HttpError(400, u.errors.join('\n'), { errors: u.errors });
      saveSettings(core.cfg, { ...v.settings, projects: u.projects }, v.thresholds);
      core.reloadRunners();
      return ok(publicSettings(core));
    },
  },
  { method: 'GET', re: /^\/api\/capabilities$/, run: ({ core }) => ok(core.capabilities()) },
  {
    method: 'POST', re: /^\/api\/guard$/,
    run: async ({ req, url, core }) => {
      const agent = url.searchParams.get('agent') ?? '';
      const token = bearer(req);
      if (!core.orchestrator.checkGuardToken(agent, token)) throw new HttpError(401, 'token không hợp lệ');
      const input = await readJson(req, GUARD_BODY_MAX);
      const d = core.orchestrator.guard(agent, token, input);
      if (!d) throw new HttpError(401, 'token không hợp lệ');
      return ok(d);
    },
  },
  {
    method: 'POST', re: /^\/mcp$/,
    run: async ({ req, url, core }) => {
      // worker: ?agent=<id> với token guard của nó (chỉ request_user_action); Controller: ?ticket=<T>
      const agent = url.searchParams.get('agent');
      if (agent !== null) {
        if (!core.orchestrator.checkWorkerMcpToken(agent, bearer(req))) throw new HttpError(401, 'token không hợp lệ');
        return handleMcp(await readJson(req), core.orchestrator.workerMcpTools(agent));
      }
      const ticket = url.searchParams.get('ticket') ?? '';
      if (!core.orchestrator.checkMcpToken(ticket, bearer(req))) throw new HttpError(401, 'token không hợp lệ');
      return handleMcp(await readJson(req), core.orchestrator.mcpTools(ticket));
    },
  },
];

function isJson(ct: string | undefined): boolean {
  return (ct ?? '').split(';')[0].trim().toLowerCase() === 'application/json';
}

/** Mọi request `/api/*` và `/mcp` (Host đã được kiểm). */
export async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, core: Core, port: number): Promise<void> {
  try {
    const matches = ROUTES.filter((r) => r.re.test(url.pathname));
    if (!matches.length) throw new HttpError(404, 'not found');
    const route = matches.find((r) => r.method === req.method);
    if (!route) throw new HttpError(405, 'method not allowed');
    if (route.method !== 'GET') {
      if (!originAllowed(req.headers.origin, port)) throw new HttpError(403, 'forbidden origin');
      if (!isJson(req.headers['content-type'])) throw new HttpError(415, 'content-type phải là application/json');
    }
    let params: string[];
    try {
      params = route.re.exec(url.pathname)!.slice(1).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, 'bad path parameter');
    }
    const r = await route.run({ req, url, core, params });
    if (r.body) {
      res.writeHead(r.status, { 'content-type': r.contentType ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(r.body);
    } else if (r.json === undefined) {
      res.writeHead(r.status, { 'cache-control': 'no-store' });
      res.end();
    } else sendJson(res, r.status, r.json);
  } catch (err) {
    if (!req.complete) req.resume(); // body chưa đọc (vd. 401 trước khi đọc): bỏ đi
    if (res.headersSent) return void res.end();
    if (err instanceof HttpError) {
      if (err.status === 413) res.setHeader('connection', 'close');
      sendJson(res, err.status, { error: err.message, ...err.extra });
    } else if (err instanceof OrchestratorError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}
