import type { AgentInfo, Alert, CallRecord } from '@/src/core/model';
import { ALERT_LABEL, fmtClock, fmtDuration } from '@/app/lib/format';
import { buildRoots, flattenTree } from '@/app/lib/tree';

const ESC = '\x1b[';
const paint = (on: boolean, code: string, s: string): string => (on ? `${ESC}${code}m${s}${ESC}0m` : s);
const green = (on: boolean, s: string) => paint(on, '32', s);
const yellow = (on: boolean, s: string) => paint(on, '33', s);
const red = (on: boolean, s: string) => paint(on, '31', s);
const dim = (on: boolean, s: string) => paint(on, '2', s);
const bold = (on: boolean, s: string) => paint(on, '1', s);

export function statusIcon(a: AgentInfo, color: boolean): string {
  if (a.status === 'running') return green(color, '●');
  if (a.status === 'idle') return '○';
  if (a.status === 'queued') return '◌';
  if (a.status === 'limited') return yellow(color, '⏸');
  return dim(color, '○');
}

function alertIcon(level: Alert['level'], color: boolean): string {
  return level === 'critical' ? red(color, '■') : yellow(color, '▲');
}

/** Session: 8 ký tự đầu của sessionId; subagent: 8 ký tự đầu của agentId (để phân biệt). */
export const shortId = (a: AgentInfo): string => (a.id.split(':')[2] ?? a.sessionId).slice(0, 8);

function activeAlerts(agentId: string, alerts: Alert[]): Alert[] {
  return alerts.filter((x) => x.agentId === agentId && x.active);
}

function worst(list: Alert[]): Alert | undefined {
  return list.find((x) => x.level === 'critical') ?? list[0];
}

function truncate(s: string, width: number): string {
  const flat = s.replace(/[\r\n\t]+/g, ' ');
  if (width <= 1 || flat.length <= width) return flat;
  return flat.slice(0, width - 1) + '…';
}

/** Tiền tố cây: depth 0 không có nhánh, còn lại dùng ├/└ và │ cho các tổ tiên chưa hết. */
function treePrefixes(nodes: { depth: number; isLast: boolean }[]): string[] {
  const lasts: boolean[] = [];
  return nodes.map((n) => {
    if (n.depth === 0) { lasts.length = 0; return ''; }
    lasts.length = n.depth;
    lasts[n.depth - 1] = n.isLast;
    let p = '';
    for (let d = 1; d < n.depth; d++) p += lasts[d - 1] ? '  ' : '│ ';
    return p + (n.isLast ? '└ ' : '├ ');
  });
}

export function renderList(
  agents: AgentInfo[],
  alerts: Alert[],
  color: boolean,
  callCounts: Record<string, number> = {},
): string {
  if (agents.length === 0) return 'Không có agent nào.';
  const rows: string[] = [];
  for (const root of buildRoots(agents)) {
    const nodes = flattenTree(root.session, agents);
    const prefixes = treePrefixes(nodes);
    nodes.forEach(({ agent: a }, i) => {
      const al = worst(activeAlerts(a.id, alerts));
      const n = callCounts[a.id];
      const alertCol = al ? `${alertIcon(al.level, color)} ${ALERT_LABEL[al.kind]}` : '';
      rows.push([
        statusIcon(a, color),
        shortId(a),
        a.source.padEnd(6),
        `${prefixes[i]}${a.label}`,
        n === undefined ? '' : `${n} call`,
        alertCol,
      ].join('  ').trimEnd());
    });
  }
  return rows.join('\n');
}

function callLine(c: CallRecord, width: number, color: boolean): string {
  const mark = c.endedAt === null ? '…' : c.ok === false ? red(color, '✗') : green(color, '✓');
  const dur = c.endedAt === null ? '' : fmtDuration(c.endedAt - c.startedAt);
  const head = `${fmtClock(c.startedAt)} ${mark} ${c.name.padEnd(8)} `;
  const tail = dur ? `  ${dur}` : '';
  const room = Math.max(10, width - 12 - c.name.padEnd(8).length - tail.length - 2);
  const body = truncate(c.inputPreview || (c.errorPreview ?? ''), room);
  return `${head}${body}${tail}`;
}

export function renderWatch(
  root: AgentInfo,
  all: AgentInfo[],
  calls: Record<string, CallRecord[]>,
  alerts: Alert[],
  width: number,
  color: boolean,
): string {
  const nodes = flattenTree(root, all);
  const prefixes = treePrefixes(nodes);
  const lines: string[] = [bold(color, `Agent CCTV · ${root.label} (${shortId(root)})`), ''];
  nodes.forEach(({ agent: a }, i) => {
    const al = worst(activeAlerts(a.id, alerts));
    const row = `${prefixes[i]}${statusIcon(a, color)} ${a.label}  ${dim(color, `${a.source} ${a.status}`)}${al ? `  ${alertIcon(al.level, color)} ${al.message}` : ''}`;
    lines.push(row);
  });

  const focus = nodes.map((n) => n.agent).reduce((best, a) => (a.lastEventAt > best.lastEventAt ? a : best), root);
  const recent = (calls[focus.id] ?? []).slice().sort((a, b) => b.startedAt - a.startedAt).slice(0, 10).reverse();
  lines.push('', dim(color, `10 call gần nhất · ${focus.label}`));
  if (recent.length === 0) lines.push(dim(color, '(chưa có call)'));
  for (const c of recent) lines.push(callLine(c, width, color));
  return lines.join('\n');
}

export function renderLogs(calls: CallRecord[], width: number, color: boolean): string {
  return calls.map((c) => callLine(c, width, color)).join('\n');
}
