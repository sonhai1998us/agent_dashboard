import { WebSocket } from 'ws';
import type { Alert, HubEvent } from '@/src/core/model';
import type { Ticket, TicketStatus } from '@/src/tickets/model';
import { ticketStatusText } from '@/app/lib/tickets';
import { recentDirs } from '@/app/lib/recentDirs';
import { jiraKey } from '@/src/orchestrator/prompts';
import { main, type CliIo } from './acctv';
import { renderPlan } from './render';

/** Lệnh chạy lâu hoặc tự bật server: không cho chạy qua chat. */
const BLOCKED = new Set(['serve', 'watch', 'telegram']);
/** Trạng thái ticket đáng báo cho người dùng. */
const NOTIFY: ReadonlySet<TicketStatus> = new Set(['awaiting_approval', 'escalated', 'done', 'cancelled']);
const TG_MAX = 4000; // Telegram giới hạn 4096 ký tự/tin
const POLL_S = 50;

/** Menu gợi ý khi gõ "/" trong Telegram (setMyCommands). */
export const BOT_COMMANDS = [
  { command: 'new', description: 'Tạo ticket: /new "tiêu đề" (rồi chọn thư mục)' },
  { command: 'ls', description: 'Liệt kê ticket và phiên đang chạy' },
  { command: 'plan', description: 'Xem kế hoạch: /plan T-3' },
  { command: 'approve', description: 'Duyệt kế hoạch: /approve T-3' },
  { command: 'revise', description: 'Góp ý kế hoạch: /revise T-3 "góp ý"' },
  { command: 'stop', description: 'Dừng agent: /stop T-3/dev-1' },
  { command: 'cancel', description: 'Huỷ ticket, dừng mọi agent: /cancel T-3' },
  { command: 'report', description: 'Báo cáo mới nhất: /report T-3' },
  { command: 'history', description: 'Báo cáo từng vòng và góp ý: /history T-3' },
  { command: 'feedback', description: 'Góp ý làm tiếp (gửi kèm ảnh được): /feedback T-3 "…"' },
  { command: 'continue', description: 'Chỉ đạo ticket cần bạn quyết: /continue T-3 "…"' },
  { command: 'logs', description: 'Call gần nhất: /logs T-3/dev-1 -n 20' },
  { command: 'send', description: 'Gửi plan cho nhóm: /send T-3 team "ghi chú"' },
  { command: 'jira', description: 'Comment lên Jira: /jira T-3 "nội dung"' },
  { command: 'help', description: 'Hướng dẫn đầy đủ' },
];
/** Lệnh do bot tự xử lý, không qua CLI. */
export const BOT_ONLY = new Set(['send', 'jira']);

// ---------- chia sẻ: nhóm Telegram và Jira ----------

/** `team:-100123,lead:4567` → Map tên → chat_id. Tên ngắn vì nằm trong callback_data (≤ 64 byte). */
export function parseContacts(s: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^([\w-]{1,30}):(-?\d+)$/.exec(part);
    if (!m) throw new Error(`TELEGRAM_CONTACTS sai ở "${part}" (dạng ten:chat_id, tên ≤ 30 ký tự chữ/số/-/_)`);
    out.set(m[1], m[2]);
  }
  return out;
}

export interface JiraCfg { base: string; email: string; token: string }

/** Nội dung chia sẻ: ticket xong thì báo cáo, còn lại là kế hoạch. */
export function shareText(t: Ticket): string {
  if (t.status === 'done' && t.report) return `${t.id} · ${t.title} · xong\n\n${t.report}${t.diffStat ? `\n\n${t.diffStat}` : ''}`;
  return renderPlan(t, false);
}

type Button = { text: string; callback_data: string };

/** Nút dưới tin về một ticket: duyệt / xem plan / chuyển cho từng nhóm / comment Jira. */
export function ticketButtons(t: Ticket, contacts: string[], jira: boolean, showPlan = true): { inline_keyboard: Button[][] } {
  const first: Button[] = [];
  if (t.status === 'awaiting_approval') first.push({ text: '✅ Duyệt', callback_data: `ap:${t.id}` });
  if (showPlan) first.push({ text: t.status === 'done' ? '📄 Báo cáo' : '📄 Xem plan', callback_data: `pl:${t.id}` });
  if (t.status === 'done') first.push({ text: '💬 Góp ý', callback_data: `fb:${t.id}` });
  if (t.status === 'escalated') first.push({ text: '🧭 Chỉ đạo', callback_data: `ct:${t.id}` });
  if (t.status === 'done' || t.status === 'escalated') first.push({ text: '🕘 Lịch sử', callback_data: `hs:${t.id}` });
  const share: Button[] = contacts.map((c) => ({ text: `➡️ ${c}`, callback_data: `fw:${t.id}:${c}` }));
  const key = jira ? jiraKey(t) : null;
  if (key) share.push({ text: `💬 Jira ${key}`, callback_data: `jr:${t.id}` });
  return { inline_keyboard: [first, share].filter((r) => r.length) };
}

/** Comment lên issue Jira bằng API token của người dùng; trả link tới comment. */
export async function postJiraComment(cfg: JiraCfg, key: string, body: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const base = cfg.base.replace(/\/+$/, '');
  const res = await fetchFn(`${base}/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64')}` },
    body: JSON.stringify({ body }),
  });
  const json = await res.json().catch(() => null) as { id?: string; errorMessages?: string[] } | null;
  if (!res.ok || !json?.id) throw new Error(json?.errorMessages?.join('; ') || `Jira trả lỗi ${res.status}`);
  return `${base}/browse/${key}?focusedCommentId=${json.id}`;
}

/** Tách tin nhắn thành argv như shell: hỗ trợ "…", '…' và ngoặc kép “…” mà điện thoại tự đổi. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|“([^”]*)”|'([^']*)'|(\S+)/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  return out;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Tin nhắn → argv của `acctv`: bỏ "/" và "@TenBot", /start = help. */
export function chatArgv(text: string): string[] {
  const argv = splitArgs(text.trim());
  if (argv[0]) argv[0] = argv[0].replace(/^\//, '').replace(/@\S+$/, ''); // "/ls@MyBot" → "ls"
  if (argv[0] === 'start') argv[0] = 'help';
  return argv;
}

/** `/new "tiêu đề"` chưa có --dir: cần hỏi thư mục. */
export const needsDir = (argv: string[]): boolean => argv[0] === 'new' && argv.length > 1 && !argv.includes('--dir');

/** Thư mục để chọn: project đã cấu hình trong Settings trước, rồi thư mục ticket gần đây. */
export function projectDirs(projects: Record<string, unknown>, tickets: Ticket[], max = 10): string[] {
  const seen = new Set<string>();
  return [...Object.keys(projects), ...recentDirs(tickets)].filter((d) => {
    const k = d.toLowerCase();
    return !seen.has(k) && seen.add(k);
  }).slice(0, max);
}

/** Nhãn nút: 2 cấp cuối của đường dẫn, đủ để phân biệt mà vừa màn hình điện thoại. */
export const dirLabel = (d: string): string => d.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || d;

/** Chạy một tin nhắn như lệnh `acctv`, trả về văn bản để gửi lại. */
export async function runCommand(text: string | string[], port: number): Promise<string> {
  const argv = typeof text === 'string' ? chatArgv(text) : text;
  if (BLOCKED.has(argv[0])) return `Lệnh "${argv[0]}" không dùng được qua Telegram.`;
  let buf = '';
  const io: CliIo = { stdout: { write: (s: string) => (buf += s) }, stderr: { write: (s: string) => (buf += s) }, color: false, width: 60 };
  await main([...argv, '--port', String(port)], io); // --port cuối cùng thắng: chat chỉ chạm được server của bot
  buf = buf.trim() || '(không có output)';
  return buf.length > TG_MAX ? '…' + buf.slice(-TG_MAX) : buf; // logs: mới nhất ở cuối nên giữ đuôi
}

export interface NotifyState { status: Map<string, TicketStatus>; alerts: Set<string> }

/** Sự kiện hub → tin báo (null nếu không đáng báo). Cập nhật state để không báo trùng. */
export function notifyText(e: HubEvent, st: NotifyState): string | null {
  if (e.type === 'ticket') {
    const t = e.ticket;
    const prev = st.status.get(t.id);
    st.status.set(t.id, t.status);
    if (prev === t.status || !NOTIFY.has(t.status)) return null;
    const s = ticketStatusText(t);
    const hint = t.status === 'awaiting_approval' ? `\nXem: /plan ${t.id} · duyệt: /approve ${t.id}` : '';
    return `${s.icon} ${t.id} ${t.title}: ${s.text}${hint}`;
  }
  if (e.type === 'alert') {
    const a = e.alert;
    if (!a.active) { st.alerts.delete(a.id); return null; }
    if (st.alerts.has(a.id)) return null;
    st.alerts.add(a.id);
    return `${a.level === 'critical' ? '🔴' : '🟡'} ${a.message}\n(${a.agentId})`;
  }
  return null;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: { file_id: string }[];
  document?: { file_id: string; mime_type?: string; file_name?: string };
  media_group_id?: string;
  reply_to_message?: { message_id: number };
}

/** Ảnh trong tin: photo (Telegram nén thành jpeg, lấy cỡ lớn nhất) hoặc file ảnh gửi dạng document. */
export function messageImages(m: TgMessage): { fileId: string; type: string; name: string }[] {
  if (m.photo?.length) return [{ fileId: m.photo[m.photo.length - 1].file_id, type: 'image/jpeg', name: 'telegram.jpg' }];
  const d = m.document;
  if (d?.mime_type?.startsWith('image/')) return [{ fileId: d.file_id, type: d.mime_type, name: d.file_name ?? 'telegram' }];
  return [];
}

type Steer = 'feedback' | 'continue';
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; data?: string; message?: TgMessage };
  my_chat_member?: { chat: { id: number; type: string; title?: string }; new_chat_member: { status: string } };
}

type Markup = { inline_keyboard: Button[][] };
const TICKET_ID = /^T-\d+$/;

export interface TelegramOptions {
  token: string;
  allowed: Set<string>;
  /** Nhóm/người chỉ nhận tin chuyển tới, không chạy được lệnh. */
  contacts: Map<string, string>;
  jira: JiraCfg | null;
  port: number;
  io: CliIo;
}

export async function runTelegram({ token, allowed, contacts, jira, port, io }: TelegramOptions): Promise<number> {
  const api = `https://api.telegram.org/bot${token}`;
  const stop = new AbortController();
  io.signal?.addEventListener('abort', () => stop.abort(), { once: true });
  const names = [...contacts.keys()];
  const logErr = (err: unknown): void => { io.stderr.write(`Gửi Telegram lỗi: ${(err as Error).message}\n`); };

  const tg = async (method: string, body: unknown): Promise<any> => {
    const res = await fetch(`${api}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: stop.signal,
    });
    const json = await res.json() as { ok: boolean; result?: unknown; description?: string; error_code?: number };
    if (!json.ok) throw Object.assign(new Error(json.description ?? `Telegram ${res.status}`), { code: json.error_code });
    return json.result;
  };
  const pre = (text: string): string => `<pre>${esc(text.length > TG_MAX ? text.slice(0, TG_MAX) + '\n…' : text)}</pre>`;
  const sendOrThrow = (chat: string, text: string, markup?: Markup): Promise<TgMessage> =>
    tg('sendMessage', { chat_id: chat, text: pre(text), parse_mode: 'HTML', ...(markup ? { reply_markup: markup } : {}) });
  const send = (chat: string, text: string, markup?: Markup): Promise<unknown> => sendOrThrow(chat, text, markup).catch(logErr);
  const edit = (chat: string, msgId: number, text: string): Promise<unknown> =>
    tg('editMessageText', { chat_id: chat, message_id: msgId, text: pre(text), parse_mode: 'HTML' }).catch(() => send(chat, text));
  const broadcast = (text: string, markup?: Markup): void => { for (const c of allowed) void send(c, text, markup); };
  const local = async <T>(p: string): Promise<T> => (await fetch(`http://127.0.0.1:${port}${p}`)).json() as Promise<T>;

  const getTicket = async (id: string): Promise<Ticket> => {
    let res: Response;
    try { res = await fetch(`http://127.0.0.1:${port}/api/tickets/${encodeURIComponent(id)}`); } catch { throw new Error('Server chưa chạy. Bật bằng: acctv serve'); }
    const json = await res.json().catch(() => null) as { ticket?: Ticket; error?: string } | null;
    if (!res.ok || !json?.ticket) throw new Error(json?.error ?? `Không tìm thấy ticket ${id}`);
    return json.ticket;
  };

  // ---- chọn thư mục cho /new ----
  /** `/new` đang chờ chọn thư mục, theo chat. Chỉ giữ yêu cầu mới nhất. */
  const pending = new Map<string, { argv: string[]; dirs: string[]; msgId: number }>();

  const askDir = async (chat: string, argv: string[]): Promise<void> => {
    let dirs: string[];
    try {
      const [tickets, { settings }] = await Promise.all([
        local<Ticket[]>('/api/tickets'),
        local<{ settings: { projects: Record<string, unknown> } }>('/api/settings'),
      ]);
      dirs = projectDirs(settings.projects, tickets);
    } catch {
      await send(chat, 'Server chưa chạy. Bật bằng: acctv serve');
      return;
    }
    if (!dirs.length) {
      await send(chat, 'Chưa có thư mục nào (chưa có ticket hay project trong Settings).\nDùng: /new "tiêu đề" --dir /đường/dẫn/tuyệt/đối');
      return;
    }
    pending.delete(chat);
    await tg('sendMessage', {
      chat_id: chat,
      text: `Chọn thư mục cho "${argv[1]}":\n${dirs.map((d, i) => `${i + 1}. ${d}`).join('\n')}`,
      reply_markup: { inline_keyboard: [
        ...dirs.map((d, i) => [{ text: `${i + 1}. ${dirLabel(d)}`, callback_data: `dir:${i}` }]),
        [{ text: 'Huỷ', callback_data: 'dir:x' }],
      ] },
    }).then((sent: TgMessage) => pending.set(chat, { argv, dirs, msgId: sent.message_id })).catch(logErr);
  };

  const onPick = async (chat: string, msgId: number, data: string): Promise<void> => {
    // Nút trên tin chọn cũ (đã có /new mới hơn) không được trỏ vào danh sách mới.
    const p = pending.get(chat)?.msgId === msgId ? pending.get(chat) : undefined;
    const i = Number(data.slice(4));
    if (!p || data === 'dir:x' || !p.dirs[i]) {
      if (p) pending.delete(chat);
      await edit(chat, msgId, p && data === 'dir:x' ? 'Đã huỷ.' : 'Yêu cầu đã hết hạn, gõ lại /new.');
      return;
    }
    pending.delete(chat);
    await edit(chat, msgId, await runCommand([...p.argv, '--dir', p.dirs[i]], port));
  };

  // ---- chuyển cho nhóm ----
  const forward = async (chat: string, t: Ticket, name: string, note = ''): Promise<void> => {
    const to = contacts.get(name);
    if (!to) { await send(chat, `Không có nhóm "${name}". Có: ${names.join(', ') || '(chưa cấu hình TELEGRAM_CONTACTS)'}`); return; }
    try {
      await sendOrThrow(to, `📤 ${note ? `${note}\n\n` : ''}${shareText(t)}`);
      await send(chat, `➡️ Đã gửi ${t.id} cho ${name}`);
    } catch (err) {
      await send(chat, `Không gửi được cho ${name}: ${(err as Error).message}\n(bot đã được thêm vào nhóm đó chưa?)`);
    }
  };

  // ---- comment Jira: luôn hỏi lại vì comment đăng dưới tên bạn ----
  // shortcut: yêu cầu chưa bấm nằm trong RAM tới khi bot tắt, đủ cho một người dùng
  const confirms = new Map<string, () => Promise<string>>();
  let seq = 0;
  const askJira = async (chat: string, t: Ticket, body: string): Promise<void> => {
    if (!jira) { await send(chat, 'Chưa cấu hình Jira: cần JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN.'); return; }
    const key = jiraKey(t);
    if (!key) { await send(chat, `${t.id} không có mã Jira trong tiêu đề (vd: [US-123] …).`); return; }
    const id = String(++seq);
    confirms.set(id, async () => `✅ Đã comment lên ${key} lúc ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}\n${await postJiraComment(jira, key, body)}`);
    await send(chat, `Comment lên ${key} (${t.title}) dưới tên bạn:\n\n${body}`, {
      inline_keyboard: [[{ text: '✅ Gửi lên Jira', callback_data: `ok:${id}` }, { text: 'Huỷ', callback_data: `no:${id}` }]],
    });
  };

  // ---- góp ý (ticket xong) / chỉ đạo (ticket cần quyết) ----
  /** Tin "Gõ góp ý…" bot đã gửi (force_reply) → ticket và loại; trả lời tin đó là góp ý. */
  const prompts = new Map<number, { kind: Steer; T: string }>();

  const askSteer = async (chat: string, kind: Steer, T: string): Promise<void> => {
    const what = kind === 'feedback' ? `Góp ý để làm tiếp ${T}` : `Chỉ đạo cho ${T}`;
    const sent = await tg('sendMessage', {
      chat_id: chat,
      text: `${what}: trả lời tin này${kind === 'feedback' ? ' (gửi kèm ảnh được, chú thích là nhận xét)' : ''}.`,
      reply_markup: { force_reply: true, input_field_placeholder: what },
    }) as TgMessage;
    prompts.set(sent.message_id, { kind, T });
  };

  const submit = async (chat: string, kind: Steer, T: string, text: string, files: ReturnType<typeof messageImages>): Promise<void> => {
    if (kind === 'continue' && files.length) { await send(chat, 'Chỉ đạo chỉ nhận chữ; ảnh dùng cho góp ý khi ticket đã xong.'); return; }
    if (!files.length) { await send(chat, await runCommand([kind, T, text], port)); return; }
    const images = await Promise.all(files.map(async (f, i) => {
      const { file_path } = await tg('getFile', { file_id: f.fileId }) as { file_path: string };
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${file_path}`, { signal: stop.signal });
      if (!res.ok) throw new Error(`Không tải được ảnh ${i + 1} từ Telegram (${res.status})`);
      return { name: f.name, type: f.type, data: Buffer.from(await res.arrayBuffer()).toString('base64') };
    }));
    const res = await fetch(`http://127.0.0.1:${port}/api/tickets/${encodeURIComponent(T)}/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, images }),
    }).catch(() => null);
    if (!res) { await send(chat, 'Server chưa chạy. Bật bằng: acctv serve'); return; }
    const json = await res.json().catch(() => null) as (Ticket & { error?: string }) | null;
    await send(chat, res.ok && json ? `${T} đã nhận góp ý (${images.length} ảnh) · ${ticketStatusText(json).text}` : `Không gửi được góp ý: ${json?.error ?? res.status}`);
  };

  /** Một tin (hoặc cả album) đã gom: trả lời tin hỏi góp ý, ảnh kèm /feedback, hoặc lệnh chữ. */
  const onMessage = async (chat: string, text: string, files: ReturnType<typeof messageImages>, replyTo?: number): Promise<void> => {
    const p = replyTo !== undefined ? prompts.get(replyTo) : undefined;
    if (p) {
      if (!text.trim() && !files.length) return;
      prompts.delete(replyTo!);
      await submit(chat, p.kind, p.T, text.trim(), files);
      return;
    }
    if (files.length) {
      const [cmd, T, ...rest] = chatArgv(text);
      if (cmd === 'feedback' && TICKET_ID.test(T ?? '')) await submit(chat, 'feedback', T, rest.join(' '), files);
      else await send(chat, 'Ảnh dùng để góp ý: gửi kèm chú thích /feedback T-3 "nhận xét", hoặc trả lời tin "Góp ý" của bot.');
      return;
    }
    await onText(chat, text);
  };

  // Album = nhiều tin cùng media_group_id tới rời nhau; gom lại rồi xử lý một lần.
  const albums = new Map<string, { chat: string; text: string; files: ReturnType<typeof messageImages>; replyTo?: number; timer: NodeJS.Timeout }>();
  const ALBUM_WAIT_MS = 1500;
  const addToAlbum = (chat: string, m: TgMessage): void => {
    const key = `${chat}:${m.media_group_id}`;
    const a = albums.get(key) ?? { chat, text: '', files: [], timer: undefined as unknown as NodeJS.Timeout };
    clearTimeout(a.timer);
    a.text ||= m.caption ?? '';
    a.replyTo ??= m.reply_to_message?.message_id;
    a.files.push(...messageImages(m));
    a.timer = setTimeout(() => {
      albums.delete(key);
      void onMessage(a.chat, a.text, a.files, a.replyTo).catch((err) => send(a.chat, (err as Error).message));
    }, ALBUM_WAIT_MS);
    albums.set(key, a);
  };

  // ---- nút bấm ----
  const onButton = async (chat: string, msgId: number, data: string): Promise<void> => {
    const [kind, a, b] = data.split(':');
    if (kind === 'dir') return onPick(chat, msgId, data);
    if (kind === 'ok' || kind === 'no') {
      const run = confirms.get(a);
      confirms.delete(a);
      if (!run) { await edit(chat, msgId, 'Yêu cầu đã hết hạn.'); return; }
      if (kind === 'no') { await edit(chat, msgId, 'Đã huỷ.'); return; }
      try { await edit(chat, msgId, await run()); } catch (err) { await edit(chat, msgId, `Jira lỗi: ${(err as Error).message}`); }
      return;
    }
    if (!TICKET_ID.test(a ?? '')) return;
    if (kind === 'ap') { await send(chat, await runCommand(['approve', a], port)); return; }
    if (kind === 'fb' || kind === 'ct') { await askSteer(chat, kind === 'fb' ? 'feedback' : 'continue', a); return; }
    if (kind === 'hs') { await send(chat, await runCommand(['history', a], port)); return; }
    const t = await getTicket(a);
    if (kind === 'pl') await send(chat, shareText(t), ticketButtons(t, names, !!jira, false));
    else if (kind === 'fw') await forward(chat, t, b);
    else if (kind === 'jr') await askJira(chat, t, `{noformat}\n${shareText(t)}\n{noformat}`);
  };

  // ---- tin nhắn ----
  const onText = async (chat: string, text: string): Promise<void> => {
    const argv = chatArgv(text);
    const [cmd, id, ...rest] = argv;
    if (BOT_ONLY.has(cmd)) {
      if (!TICKET_ID.test(id ?? '')) { await send(chat, cmd === 'send' ? 'Dùng: /send T-3 <nhóm> ["ghi chú"]' : 'Dùng: /jira T-3 ["nội dung"]'); return; }
      const t = await getTicket(id);
      if (cmd === 'send') {
        if (!rest[0]) { await send(chat, `Dùng: /send ${id} <nhóm> ["ghi chú"] · nhóm: ${names.join(', ') || '(chưa cấu hình)'}`); return; }
        await forward(chat, t, rest[0], rest.slice(1).join(' '));
      } else {
        await askJira(chat, t, rest.length ? rest.join(' ') : `{noformat}\n${shareText(t)}\n{noformat}`);
      }
      return;
    }
    if (needsDir(argv)) { await askDir(chat, argv); return; }
    const out = await runCommand(argv, port);
    // Đọc plan xong là chuyển/duyệt được ngay từ tin đó.
    const t = cmd === 'plan' && TICKET_ID.test(id ?? '') ? await getTicket(id).catch(() => null) : null;
    await send(chat, out, t ? ticketButtons(t, names, !!jira, false) : undefined);
  };

  try {
    // Bỏ tin dồn lúc bot tắt: không chạy lại một "approve" cũ.
    await tg('deleteWebhook', { drop_pending_updates: true });
    const me = await tg('getMe', {}) as { username: string };
    await tg('setMyCommands', { commands: BOT_COMMANDS });
    io.stdout.write(`Bot @${me.username} đang nghe · server cổng ${port} · ${allowed.size} chat được phép · ${contacts.size} nhóm · Jira ${jira ? 'bật' : 'tắt'}\n`);
  } catch (err) {
    io.stderr.write(`Không kết nối được Telegram: ${(err as Error).message}\n`);
    return 1;
  }

  // ---- báo sự kiện qua WebSocket hub ----
  const st: NotifyState = { status: new Map(), alerts: new Set() };
  let ws: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  const connect = (): void => {
    if (stop.signal.aborted) return;
    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws = sock;
    sock.on('open', async () => {
      // Nạp trạng thái hiện tại (không báo) để chỉ báo thay đổi từ giờ.
      try {
        const snap = await local<{ tickets: Ticket[]; alerts: Alert[] }>('/api/snapshot');
        for (const t of snap.tickets) st.status.set(t.id, t.status);
        for (const a of snap.alerts) if (a.active) st.alerts.add(a.id);
      } catch { /* 'close' sẽ nối lại */ }
    });
    sock.on('message', (data) => {
      try {
        const e = JSON.parse(String(data)) as HubEvent;
        const msg = notifyText(e, st);
        if (!msg) return;
        broadcast(msg, e.type === 'ticket' && e.ticket.status !== 'cancelled' ? ticketButtons(e.ticket, names, !!jira) : undefined);
      } catch { /* bỏ qua tin hỏng */ }
    });
    sock.on('error', () => { /* 'close' xử lý */ });
    sock.on('close', () => { retry = setTimeout(connect, 5000); });
  };
  connect();

  // ---- nhận lệnh qua long-polling ----
  const contactChats = new Set(contacts.values());
  let offset = 0;
  while (!stop.signal.aborted) {
    let updates: TgUpdate[];
    try {
      updates = await tg('getUpdates', { offset, timeout: POLL_S, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
    } catch (err) {
      if (stop.signal.aborted) break;
      const code = (err as { code?: number }).code;
      if (code === 401 || code === 409) { // token sai / bot đang chạy ở nơi khác
        io.stderr.write(`Telegram từ chối: ${(err as Error).message}\n`);
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      try {
        const mc = u.my_chat_member;
        if (mc) {
          // Báo chat_id cho chủ bot (không nói trong nhóm) để thêm vào TELEGRAM_CONTACTS.
          if (mc.chat.type !== 'private' && ['member', 'administrator'].includes(mc.new_chat_member.status)) {
            broadcast(`Bot vừa được thêm vào "${mc.chat.title ?? mc.chat.id}" · chat_id ${mc.chat.id}\nĐể chuyển ticket vào đây: TELEGRAM_CONTACTS=ten:${mc.chat.id}`);
          }
          continue;
        }
        const cb = u.callback_query;
        if (cb) {
          void tg('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
          const chat = cb.message ? String(cb.message.chat.id) : '';
          if (cb.message && cb.data && allowed.has(chat)) await onButton(chat, cb.message.message_id, cb.data).catch((err) => send(chat, (err as Error).message));
          continue;
        }
        const m = u.message;
        if (!m || (!m.text && !messageImages(m).length)) continue;
        const chat = String(m.chat.id);
        if (!allowed.has(chat)) {
          if (contactChats.has(chat)) continue; // nhóm chỉ nhận tin: im lặng
          io.stderr.write(`Chặn tin từ chat ${chat}\n`);
          await send(chat, `Chat này không có quyền. chat_id: ${chat}\nThêm vào TELEGRAM_ALLOWED_CHAT nếu đây là bạn.`);
          continue;
        }
        if (m.media_group_id) addToAlbum(chat, m);
        else await onMessage(chat, m.text ?? m.caption ?? '', messageImages(m), m.reply_to_message?.message_id).catch((err) => send(chat, (err as Error).message));
      } catch (err) {
        io.stderr.write(`Lỗi xử lý tin: ${(err as Error).message}\n`);
      }
    }
  }

  clearTimeout(retry);
  for (const a of albums.values()) clearTimeout(a.timer);
  try { ws?.terminate(); } catch { /* đã đóng */ }
  return stop.signal.aborted ? 0 : 1;
}
