import { describe, expect, test } from 'vitest';
import type { AgentInfo } from '@/src/core/model';
import type { Ticket } from '@/src/tickets/model';
import type { WaitSpan } from '@/src/tickets/model';
import { canFeedback, feedbackFileError, canMerge, mergeText, agentWorkMs, ticketDuration, controllerIdOf, isExternal, isStartingUp, layoutWaits, managedStateText, replayRange, reportBlocks, roleOverrides, statusAction, ticketStatusText } from '@/app/lib/tickets';

const t = (o: Partial<Ticket>): Ticket => ({ id: 'T-1', status: 'draft', round: 0, maxRounds: 3, ...o } as Ticket);

describe('tickets helpers', () => {
  test('controllerIdOf', () => expect(controllerIdOf('T-1')).toBe('acctv:T-1:controller'));
  test('ticketStatusText: running hiện vòng', () => {
    const r = ticketStatusText(t({ status: 'running', round: 1, maxRounds: 3 }));
    expect(r.text).toBe('đang chạy · vòng 2/3');
    expect(ticketStatusText(t({ status: 'running', round: 3, maxRounds: 3 })).text).toBe('đang chạy · vòng 3/3');
    expect(r.icon).toBe('●');
    expect(r.tone).toBe('run');
  });
  test('ticketStatusText: các trạng thái còn lại', () => {
    expect(ticketStatusText(t({ status: 'draft' }))).toEqual({ icon: '○', text: 'nháp', tone: 'wait' });
    expect(ticketStatusText(t({ status: 'planning' }))).toEqual({ icon: '●', text: 'đang lập kế hoạch', tone: 'run' });
    expect(ticketStatusText(t({ status: 'awaiting_approval' }))).toEqual({ icon: '▲', text: 'chờ duyệt', tone: 'warn' });
    expect(ticketStatusText(t({ status: 'done' }))).toEqual({ icon: '✓', text: 'xong', tone: 'ok' });
    expect(ticketStatusText(t({ status: 'escalated' }))).toEqual({ icon: '■', text: 'cần bạn quyết', tone: 'crit' });
    expect(ticketStatusText(t({ status: 'cancelled' }))).toEqual({ icon: '○', text: 'đã huỷ', tone: 'ended' });
  });
  test('managedStateText', () => {
    expect(managedStateText('limited')).toMatchObject({ icon: '⏸', text: 'bị giới hạn' });
    expect(managedStateText('interrupted')).toMatchObject({ icon: '○', text: 'bị gián đoạn' });
    expect(managedStateText('failed')).toMatchObject({ icon: '✗', text: 'thất bại' });
  });
  test('isExternal', () => {
    expect(isExternal({ id: 'acctv:T-1:dev-1' } as AgentInfo)).toBe(false);
    expect(isExternal({ id: 'claude:abc' } as AgentInfo)).toBe(true);
  });
});

describe('layoutWaits', () => {
  const win = { start: 0, end: 600_000 };
  const w = (o: Partial<WaitSpan>): WaitSpan => ({ id: 'w', agentId: 'a', kind: 'approval', startedAt: 0, endedAt: 1000, ...o });
  test('span mở từ giữa cửa sổ kéo tới cuối', () => {
    const r = layoutWaits([w({ startedAt: 300_000, endedAt: null })], 'a', win, 200);
    expect(r).toHaveLength(1);
    expect(r[0].x).toBe(100);
    expect(r[0].w).toBe(100);
  });
  test('bỏ span của agent khác và span ngoài cửa sổ; tiêu đề theo loại', () => {
    const r = layoutWaits([
      w({ id: '1', agentId: 'b' }), w({ id: '2', kind: 'agents', startedAt: 60_000, endedAt: 120_000 }),
      w({ id: '3', startedAt: 700_000, endedAt: 800_000 }),
    ], 'a', win, 600);
    expect(r).toEqual([{ x: 60, w: 60, title: 'chờ subagent · 1m00', kind: 'agents' }]);
  });
  test('span mở: tooltip tính theo now', () => {
    expect(layoutWaits([w({ startedAt: 300_000, endedAt: null })], 'a', win, 200, 900_000)[0].title).toBe('chờ duyệt kế hoạch · 10m00');
  });
  test('chờ duyệt kế hoạch', () => {
    expect(layoutWaits([w({ startedAt: 0, endedAt: 30_000 })], 'a', win, 600)[0].title).toBe('chờ duyệt kế hoạch · 30s');
  });
  test('khởi động và gián đoạn có kind và tooltip riêng', () => {
    const r = layoutWaits([
      w({ id: '1', kind: 'startup', startedAt: 0, endedAt: 7000 }), w({ id: '2', kind: 'interrupted', startedAt: 60_000, endedAt: 105_000 }),
    ], 'a', win, 600);
    expect(r.map((b) => b.kind)).toEqual(['startup', 'interrupted']);
    expect(r[0].title).toBe('claude đang khởi động lượt chạy · 7s');
    expect(r[1].title).toMatch(/^gián đoạn: dashboard tắt\/khởi động lại.* · 45s$/);
  });
  test('isStartingUp: chỉ khi có khoảng startup còn mở của đúng agent', () => {
    expect(isStartingUp([w({ kind: 'startup', endedAt: null })], 'a')).toBe(true);
    expect(isStartingUp([w({ kind: 'startup', endedAt: 5 })], 'a')).toBe(false);
    expect(isStartingUp([w({ kind: 'startup', endedAt: null, agentId: 'b' })], 'a')).toBe(false);
    expect(isStartingUp([w({ kind: 'approval', endedAt: null })], 'a')).toBe(false);
  });
});

describe('replayRange', () => {
  const a = (o: Partial<AgentInfo>): AgentInfo => ({ id: 'x', status: 'ended', startedAt: 10, lastEventAt: 50, ...o } as AgentInfo);
  test('tất cả đã kết thúc: không live, max = lastEventAt lớn nhất', () => {
    expect(replayRange([a({ startedAt: 20, lastEventAt: 50 }), a({ startedAt: 10, lastEventAt: 90 })], 1000)).toEqual({ min: 10, max: 90, live: false });
  });
  test('node idle vẫn live, max = now', () => {
    expect(replayRange([a({ status: 'idle' as AgentInfo['status'] })], 1000)).toEqual({ min: 10, max: 1000, live: true });
  });
  test('queued/limited/running là live', () => {
    expect(replayRange([a({}), a({ status: 'queued' })], 1000)).toEqual({ min: 10, max: 1000, live: true });
    expect(replayRange([a({ status: 'limited' })], 1000).live).toBe(true);
  });
});

describe('statusAction: badge trạng thái dẫn tới việc cần làm', () => {
  test('chờ duyệt → trang duyệt kế hoạch; escalated → mở phần cần quyết; còn lại → không có', () => {
    expect(statusAction(t({ status: 'awaiting_approval', id: 'T-3' }))).toEqual({ kind: 'plan', href: '/tickets/T-3/plan', label: 'Mở trang duyệt kế hoạch' });
    expect(statusAction(t({ status: 'escalated' }))).toEqual({ kind: 'decide', label: 'Xem điều Controller cần bạn quyết' });
    for (const s of ['draft', 'planning', 'running', 'done', 'cancelled'] as const) expect(statusAction(t({ status: s }))).toBeNull();
  });
});

describe('reportBlocks: markdown nhẹ của báo cáo Controller', () => {
  test('đoạn, đậm, code, danh sách gạch và đánh số; dòng trống bị bỏ', () => {
    const md = 'Ticket **US-5039** chưa làm.\n\n**Vì sao:**\n- Không có lệnh `twg`.\n  - lồng\n1. Cài `twg`\n2. Dán nội dung\n';
    expect(reportBlocks(md)).toEqual([
      { kind: 'p', parts: [{ text: 'Ticket ', style: 'text' }, { text: 'US-5039', style: 'bold' }, { text: ' chưa làm.', style: 'text' }] },
      { kind: 'p', parts: [{ text: 'Vì sao:', style: 'bold' }] },
      { kind: 'li', marker: '•', parts: [{ text: 'Không có lệnh ', style: 'text' }, { text: 'twg', style: 'code' }, { text: '.', style: 'text' }] },
      { kind: 'li', marker: '•', parts: [{ text: 'lồng', style: 'text' }] },
      { kind: 'li', marker: '1.', parts: [{ text: 'Cài ', style: 'text' }, { text: 'twg', style: 'code' }] },
      { kind: 'li', marker: '2.', parts: [{ text: 'Dán nội dung', style: 'text' }] },
    ]);
  });
  test('dấu ** hoặc ` không đóng thì giữ nguyên chữ', () => {
    expect(reportBlocks('a **b và `c')).toEqual([{ kind: 'p', parts: [{ text: 'a **b và `c', style: 'text' }] }]);
  });
  test('rỗng / null → không có khối nào', () => {
    expect(reportBlocks('')).toEqual([]);
    expect(reportBlocks(null)).toEqual([]);
  });
});

describe('roleOverrides: form gửi đúng lựa chọn đang hiển thị cho mọi vai', () => {
  test('mọi vai đều được gửi, kể cả khi trùng mặc định', () => {
    const spec = (model: string) => ({ agent: 'claude' as const, model, effort: 'high' as const });
    const specs = { controller: spec('claude-opus-5-5'), explorer: spec('claude-haiku-5-5'), dev: spec('claude-sonnet-5-5'), designer: spec('claude-sonnet-5-5'), qc: spec('claude-haiku-5-5') };
    expect(roleOverrides(specs)).toEqual(specs);
    expect(roleOverrides(specs).dev).not.toBe(specs.dev);
  });
});

describe('thời gian ticket và subagent', () => {
  const agent = (id: string, startedAt: number, lastEventAt: number, status: AgentInfo['status'] = 'ended') =>
    ({ id, startedAt, lastEventAt, status }) as AgentInfo;
  const tk = (status: Ticket['status']) => ({ id: 'T-4', status, createdAt: 1_000, updatedAt: 99_000 }) as Ticket;
  const wait = (agentId: string, kind: WaitSpan['kind'], startedAt: number, endedAt: number | null): WaitSpan => ({ id: `${agentId}-${startedAt}`, agentId, kind, startedAt, endedAt });

  test('agentWorkMs: đã xong tính tới event cuối, đang chạy tính tới now', () => {
    expect(agentWorkMs(agent('a', 1_000, 61_000), 500_000)).toBe(60_000);
    expect(agentWorkMs(agent('a', 1_000, 5_000, 'running'), 31_000)).toBe(30_000);
    expect(agentWorkMs(agent('a', 9_000, 5_000, 'idle'), 1_000)).toBe(0);
  });

  test('ticketDuration: đã xong → tới event cuối của agent trong ticket; chờ duyệt cộng riêng', () => {
    const agents = [agent('acctv:T-4:controller', 1_000, 600_000), agent('acctv:T-4:dev-1', 200_000, 500_000), agent('acctv:T-5:dev-1', 0, 9_999_999), agent('claude:x', 0, 9_999_999)];
    const waits = [
      wait('acctv:T-4:controller', 'approval', 60_000, 120_000),
      wait('acctv:T-4:controller', 'agents', 200_000, 500_000),
      wait('acctv:T-5:controller', 'approval', 0, 900_000),
    ];
    expect(ticketDuration(tk('done'), agents, waits, 9e12)).toEqual({ totalMs: 599_000, approvalMs: 60_000, live: false });
  });

  test('ticketDuration: đang chạy → tới now; wait duyệt còn mở tính tới now', () => {
    const waits = [wait('acctv:T-4:controller', 'approval', 61_000, null)];
    expect(ticketDuration(tk('awaiting_approval'), [], waits, 121_000)).toEqual({ totalMs: 120_000, approvalMs: 60_000, live: true });
    // chưa có agent và đã huỷ: dùng updatedAt
    expect(ticketDuration(tk('cancelled'), [], [], 9e12).totalMs).toBe(98_000);
  });
});

describe('merge', () => {
  test('canMerge: ticket đã dừng và có nhánh', () => {
    for (const status of ['done', 'escalated', 'cancelled'] as const) expect(canMerge(t({ status, branch: 'acctv/T-1' }))).toBe(true);
    for (const status of ['draft', 'planning', 'awaiting_approval', 'running'] as const) expect(canMerge(t({ status, branch: 'acctv/T-1' }))).toBe(false);
    expect(canMerge(t({ status: 'done', branch: null }))).toBe(false);
  });
  test('mergeText', () => {
    const at = new Date(2026, 10, 8, 9, 5, 7).getTime();
    expect(mergeText(null)).toBeNull();
    expect(mergeText({ target: 'main', at, result: 'merged', head: 'abcdef1234', fastForward: true, upToDate: false }))
      .toEqual({ tone: 'ok', text: 'đã merge vào main @ abcdef1 (fast-forward) · 09:05:07' });
    expect(mergeText({ target: 'dev', at, result: 'merged', head: 'abcdef1234', fastForward: false, upToDate: false }))
      .toEqual({ tone: 'ok', text: 'đã merge vào dev @ abcdef1 · 09:05:07' });
    expect(mergeText({ target: 'main', at, result: 'merged', head: 'abcdef1234', fastForward: false, upToDate: true })!.text)
      .toBe('main đã có sẵn mọi thay đổi của nhánh ticket, không có gì mới để merge · 09:05:07');
    expect(mergeText({ target: 'main', at, result: 'conflict', conflicts: ['a.ts'] }))
      .toEqual({ tone: 'crit', text: 'merge vào main bị xung đột · 09:05:07' });
  });
});

describe('góp ý', () => {
  test('canFeedback: chỉ ticket đã xong', () => {
    expect(canFeedback(t({ status: 'done' }))).toBe(true);
    for (const status of ['escalated', 'cancelled', 'running', 'planning'] as const) expect(canFeedback(t({ status }))).toBe(false);
  });
  test('feedbackFileError', () => {
    const f = (type: string, size = 10, name = 'a') => ({ name, type, size });
    expect(feedbackFileError(f('image/png'), 0)).toBeNull();
    expect(feedbackFileError(f('image/jpeg'), 5)).toBeNull();
    expect(feedbackFileError(f('image/png'), 6)).toBe('Tối đa 6 ảnh mỗi lần góp ý');
    expect(feedbackFileError(f('image/svg+xml', 10, 'x.svg'), 0)).toBe('x.svg: chỉ nhận ảnh png, jpg, webp, gif');
    expect(feedbackFileError(f('image/png', 5 * 1024 * 1024 + 1, 'big.png'), 0)).toBe('big.png: ảnh lớn hơn 5MB');
  });
});
