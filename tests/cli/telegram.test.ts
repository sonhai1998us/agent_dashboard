import { expect, test } from 'vitest';
import { BOT_COMMANDS, BOT_ONLY, chatArgv, messageImages, parseContacts, postJiraComment, shareText, ticketButtons, dirLabel, needsDir, notifyText, projectDirs, runCommand, splitArgs, type NotifyState } from '@/cli/telegram';
import type { Ticket } from '@/src/tickets/model';
import type { Alert } from '@/src/core/model';

test('splitArgs: tách theo khoảng trắng, giữ cụm trong ngoặc kép (kể cả “…” của điện thoại)', () => {
  expect(splitArgs('revise T-3 "thêm test cho login"')).toEqual(['revise', 'T-3', 'thêm test cho login']);
  expect(splitArgs('new “Sửa lỗi header” --dir /a/b')).toEqual(['new', 'Sửa lỗi header', '--dir', '/a/b']);
  expect(splitArgs("revise T-1 'a b'")).toEqual(['revise', 'T-1', 'a b']);
  expect(splitArgs('  ')).toEqual([]);
});

test('runCommand: /start và /help@Bot in hướng dẫn; serve/watch/telegram bị chặn', async () => {
  expect(await runCommand('/start', 1)).toContain('Dùng: acctv');
  expect(await runCommand('/help@MyBot', 1)).toContain('Dùng: acctv');
  for (const c of ['/serve', 'watch T-1', '/telegram']) expect(await runCommand(c, 1)).toMatch(/không dùng được qua Telegram/);
});

test('runCommand: server tắt thì báo lỗi thay vì ném', async () => {
  expect(await runCommand('/ls', 1)).toContain('Server chưa chạy');
});

const ticket = (status: Ticket['status']) => ({ id: 'T-1', title: 'Demo', status, round: 0, maxRounds: 3 }) as Ticket;
const alert = (active: boolean) => ({ id: 'a1', agentId: 'x', kind: 'stuck', level: 'critical', message: 'kẹt 10 phút', since: 0, active }) as Alert;

test('notifyText: chỉ báo khi trạng thái đổi sang trạng thái đáng báo, không báo trùng', () => {
  const st: NotifyState = { status: new Map(), alerts: new Set() };
  expect(notifyText({ type: 'ticket', ticket: ticket('planning') }, st)).toBeNull();
  expect(notifyText({ type: 'ticket', ticket: ticket('awaiting_approval') }, st)).toContain('/approve T-1');
  expect(notifyText({ type: 'ticket', ticket: ticket('awaiting_approval') }, st)).toBeNull();
  expect(notifyText({ type: 'ticket', ticket: ticket('done') }, st)).toContain('xong');
});

test('notifyText: alert báo một lần khi bật, báo lại được sau khi tắt rồi bật', () => {
  const st: NotifyState = { status: new Map(), alerts: new Set() };
  expect(notifyText({ type: 'alert', alert: alert(true) }, st)).toContain('kẹt 10 phút');
  expect(notifyText({ type: 'alert', alert: alert(true) }, st)).toBeNull();
  expect(notifyText({ type: 'alert', alert: alert(false) }, st)).toBeNull();
  expect(notifyText({ type: 'alert', alert: alert(true) }, st)).not.toBeNull();
});

test('needsDir: chỉ /new có tiêu đề mà thiếu --dir', () => {
  expect(needsDir(chatArgv('/new "Sửa header"'))).toBe(true);
  expect(needsDir(chatArgv('/new "Sửa header" --dir /a'))).toBe(false);
  expect(needsDir(chatArgv('/new'))).toBe(false);
  expect(needsDir(chatArgv('/ls'))).toBe(false);
});

test('projectDirs: project trong Settings trước, rồi thư mục ticket gần đây, bỏ trùng', () => {
  const t = (dir: string, createdAt: number) => ({ dir, createdAt }) as Ticket;
  expect(projectDirs({ '/w/app': {} }, [t('/w/old', 1), t('/W/APP', 3), t('/w/new', 2)]))
    .toEqual(['/w/app', '/w/new', '/w/old']);
  expect(dirLabel('/Users/me/Project/app')).toBe('Project/app');
  expect(dirLabel('C:\\Work\\demo')).toBe('Work/demo');
});

test('BOT_COMMANDS: tên hợp lệ với Telegram và đều là lệnh CLI chạy được qua chat', async () => {
  for (const c of BOT_COMMANDS) {
    expect(c.command).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(c.description.length).toBeLessThanOrEqual(256);
    if (BOT_ONLY.has(c.command)) continue;
    expect(await runCommand(`/${c.command}`, 1)).not.toMatch(/Lệnh không biết|không dùng được qua Telegram/);
  }
});

test('parseContacts: ten:chat_id, báo lỗi rõ khi sai dạng', () => {
  expect([...parseContacts(' team:-100123 , lead:4567,')]).toEqual([['team', '-100123'], ['lead', '4567']]);
  expect(parseContacts('').size).toBe(0);
  expect(() => parseContacts('team=-100')).toThrow(/TELEGRAM_CONTACTS sai/);
});

const full = (o: Partial<Ticket>) => ({ id: 'T-7', title: '[US-4621] Bỏ toggle LA', description: '', status: 'awaiting_approval', round: 0, maxRounds: 3,
  plan: { summary: 'Bỏ công tắc', difficulty: 'dễ', roles: { dev: { count: 1, agent: 'claude', model: 'm', effort: 'low' }, designer: { count: 0 }, qc: { count: 0 } }, packages: [], acceptance: ['ok'] },
  report: null, diffStat: null, ...o }) as unknown as Ticket;

test('ticketButtons: duyệt chỉ khi chờ duyệt; mỗi nhóm một nút; nút Jira khi có mã và bật Jira; callback_data ≤ 64 byte', () => {
  const kb = ticketButtons(full({}), ['team', 'a'.repeat(30)], true).inline_keyboard;
  expect(kb[0].map((b) => b.callback_data)).toEqual(['ap:T-7', 'pl:T-7']);
  expect(kb[1].map((b) => b.callback_data)).toEqual(['fw:T-7:team', `fw:T-7:${'a'.repeat(30)}`, 'jr:T-7']);
  expect(kb[1][2].text).toContain('US-4621');
  for (const b of kb.flat()) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);

  expect(ticketButtons(full({ status: 'running' }), [], false, false).inline_keyboard).toEqual([]);
  expect(ticketButtons(full({ title: 'không mã' }), [], true).inline_keyboard.flat().some((b) => b.callback_data.startsWith('jr:'))).toBe(false);
});

test('shareText: ticket xong có báo cáo thì gửi báo cáo, còn lại gửi plan', () => {
  expect(shareText(full({}))).toContain('Bỏ công tắc');
  expect(shareText(full({ status: 'done', report: 'Đã bỏ toggle', diffStat: '2 files' }))).toMatch(/xong[\s\S]*Đã bỏ toggle[\s\S]*2 files/);
});

test('postJiraComment: gọi API v2 bằng Basic auth, trả link tới comment; lỗi Jira thành Error', async () => {
  const calls: [string, RequestInit][] = [];
  const ok = (async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return new Response(JSON.stringify({ id: '19990' }), { status: 201 });
  }) as unknown as typeof fetch;
  const cfg = { base: 'https://x.atlassian.net/', email: 'a@b.c', token: 'tok' };
  expect(await postJiraComment(cfg, 'US-4621', 'hi', ok)).toBe('https://x.atlassian.net/browse/US-4621?focusedCommentId=19990');
  expect(calls[0][0]).toBe('https://x.atlassian.net/rest/api/2/issue/US-4621/comment');
  expect((calls[0][1].headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('a@b.c:tok').toString('base64')}`);
  expect(JSON.parse(String(calls[0][1].body))).toEqual({ body: 'hi' });

  const bad = (async () => new Response(JSON.stringify({ errorMessages: ['Issue does not exist'] }), { status: 404 })) as unknown as typeof fetch;
  await expect(postJiraComment(cfg, 'US-1', 'hi', bad)).rejects.toThrow('Issue does not exist');
});

test('ticketButtons: xong có Góp ý + Lịch sử, cần quyết có Chỉ đạo + Lịch sử', () => {
  const data = (st: Ticket['status']) => ticketButtons(full({ status: st }), [], false).inline_keyboard.flat().map((b) => b.callback_data);
  expect(data('done')).toEqual(['pl:T-7', 'fb:T-7', 'hs:T-7']);
  expect(data('escalated')).toEqual(['pl:T-7', 'ct:T-7', 'hs:T-7']);
  expect(data('running')).toEqual(['pl:T-7']);
});

test('messageImages: photo lấy cỡ lớn nhất; document chỉ khi là ảnh', () => {
  const base = { message_id: 1, chat: { id: 1 } };
  expect(messageImages({ ...base, photo: [{ file_id: 's' }, { file_id: 'l' }] })).toEqual([{ fileId: 'l', type: 'image/jpeg', name: 'telegram.jpg' }]);
  expect(messageImages({ ...base, document: { file_id: 'd', mime_type: 'image/png', file_name: 'a.png' } })).toEqual([{ fileId: 'd', type: 'image/png', name: 'a.png' }]);
  expect(messageImages({ ...base, document: { file_id: 'd', mime_type: 'application/pdf' } })).toEqual([]);
  expect(messageImages({ ...base, text: 'hi' })).toEqual([]);
});
