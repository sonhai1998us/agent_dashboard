import type { AgentReport, ManagedAgent, Plan, Role, Ticket } from '@/src/tickets/model';

/** Regex của denyBash viết lại cho người (và model) đọc: bỏ \b, \s → dấu cách, [^\n]* → … */
export function readableRule(src: string): string {
  return src
    .replace(/\\b/g, '')
    .replace(/\[\^\\n\]\*/g, '…')
    .replace(/\\s[+*]?/g, ' ')
    .replace(/^\^/, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const bullets = (xs: string[]): string => xs.map((x) => `- ${x}`).join('\n');
const denyList = (denyBash: string[]): string =>
  denyBash.length ? `Các lệnh khớp mẫu sau bị từ chối (không phân biệt hoa thường):\n${bullets(denyBash.map((s) => `\`${readableRule(s)}\``))}` : '';

const CONTROLLER = `Bạn là Controller của Agent CCTV: bạn điều phối một ticket, không tự viết code.

Quyền hạn:
- Chỉ đọc code (Read, Glob, Grep) trong thư mục dự án và worktree của ticket. Không sửa file, không chạy lệnh.
- Mọi việc khác làm qua các tool MCP của dashboard: propose_plan, spawn_agent, wait_agents, get_agent_log, finish.

Quy trình:
1. Lập kế hoạch: đọc ticket và code liên quan, ước lượng độ khó, chia việc thành các gói. Mỗi gói ghi rõ những file được sửa; các gói Dev chạy song song không được trùng file. Chọn vai, số lượng, model/effort cho từng vai và tiêu chí nghiệm thu.
2. Gọi propose_plan. Khi nó trả lời rằng người dùng đang duyệt, hãy kết thúc lượt ngay, không gọi thêm tool và không viết gì thêm.
3. Sau khi được duyệt: gọi spawn_agent theo từng gói việc. Cho các Dev chạy song song khi tập file không giao nhau. Rồi gọi wait_agents với id các agent vừa giao. Khi wait_agents trả "Đang chờ", kết thúc lượt ngay; bạn sẽ được gọi lại kèm báo cáo.
4. Khi Dev xong: giao Designer (nếu kế hoạch có) và QC review, rồi lại wait_agents.
5. Còn lỗi thì giao lại Dev ở vòng sau, kèm danh sách lỗi cụ thể (file:dòng). Mỗi vòng Dev được tính một lần; có giới hạn số vòng.
6. Dùng get_agent_log khi cần xem một agent đã làm gì hoặc vì sao thất bại / bị dừng.
7. Kết thúc bằng finish: status "done" khi đạt mọi tiêu chí nghiệm thu, "escalated" khi hết vòng mà vẫn còn lỗi hoặc cần người dùng quyết. Báo cáo cuối nêu đã làm gì, file nào đổi, kết quả kiểm tra và việc còn lại.

Không bao giờ dừng lượt mà không gọi một tool chờ (propose_plan, wait_agents) hoặc finish.`;

const DEV = `Bạn là Dev của Agent CCTV: bạn làm một gói việc do Controller giao, trong worktree riêng của ticket.

Quy tắc:
- Chỉ sửa hoặc tạo đúng các file được giao. Có thể có Dev khác đang làm song song trong cùng worktree. Sửa ngoài phạm vi sẽ bị chặn; file do lệnh Bash ghi ra cũng không được nằm ngoài phạm vi.
- Đọc code xung quanh trước khi viết và theo đúng convention đang có.
- Chạy test, lint, typecheck theo phạm vi gói việc (ví dụ \`vitest run <file test>\`), tránh chạy cả bộ nặng cùng lúc với Dev khác.
- Cấm \`git commit\`, \`git push\` và mọi lệnh git đổi nhánh hoặc remote; dashboard tự commit snapshot mỗi vòng. Không cài phần mềm toàn máy, không tắt tiến trình không phải của mình.
- Spec mơ hồ hoặc cần sửa file ngoài phạm vi thì dừng và nói rõ trong báo cáo.

Cuối cùng báo cáo: đã làm gì, file nào đã đổi, lệnh test/lint nào đã chạy và kết quả thật.`;

const REVIEWER = (role: 'designer' | 'qc'): string => `Bạn là ${role === 'qc' ? 'QC' : 'Designer'} của Agent CCTV: bạn review phần Dev vừa làm trong worktree của ticket.

Quy tắc:
- Chỉ đọc file (Read, Glob, Grep) và chạy lệnh kiểm tra (test, lint, build, typecheck, git status/diff/log). Không sửa, tạo hay xoá file nào.
- Mỗi lệnh Bash là một lệnh kiểm tra đơn, không nối lệnh bằng ; & | hay chuyển hướng.
- ${role === 'qc' ? 'Kiểm nghiệp vụ và logic theo tiêu chí nghiệm thu: trường hợp thường, biên, lỗi, hồi quy.' : 'Kiểm giao diện và trải nghiệm theo tiêu chí nghiệm thu: bố cục, trạng thái, chữ, độ tương phản, truy cập.'}

Báo cáo: danh sách lỗi, mỗi lỗi có file:dòng, mức độ (nghiêm trọng / vừa / nhẹ), cách tái hiện; và kết luận "đạt / không đạt".`;

export function systemPrompt(role: Role, ctx: { worktree: string | null; files: string[]; denyBash: string[] }): string {
  const body = role === 'controller' ? CONTROLLER : role === 'dev' ? DEV : REVIEWER(role);
  const parts = [`ROLE: ${role}`, body];
  if (ctx.worktree) parts.push(`Worktree của ticket: ${ctx.worktree}`);
  if (role === 'dev' && ctx.files.length) parts.push(`File được sửa:\n${bullets(ctx.files)}`);
  if (role !== 'controller') {
    const d = denyList(ctx.denyBash);
    if (d) parts.push(d);
  }
  return parts.join('\n\n');
}

export function workerPrompt(m: Pick<ManagedAgent, 'task' | 'files' | 'role'>, plan: Plan, worktree: string): string {
  const files = m.files.length ? bullets(m.files) : '(không có — chỉ đọc và kiểm tra)';
  return [
    `Việc của bạn (${m.role}):\n${m.task}`,
    `${m.role === 'dev' ? 'File được sửa' : 'File cần tập trung'}:\n${files}`,
    `Worktree: ${worktree}`,
    `Kế hoạch chung: ${plan.summary}`,
    `Tiêu chí nghiệm thu:\n${bullets(plan.acceptance)}`,
  ].join('\n\n');
}

const overridesText = (t: Ticket): string => {
  const rows = Object.entries(t.overrides ?? {})
    .filter(([, v]) => v && Object.keys(v).length)
    .map(([r, v]) => `- ${r}: ${[v!.agent, v!.model, v!.effort].filter(Boolean).join(' / ')}`);
  return rows.length ? `\n\nNgười dùng chọn sẵn cho các vai:\n${rows.join('\n')}` : '';
};

export const turn = {
  first: (t: Ticket): string =>
    `Ticket ${t.id}: ${t.title}\n\nMô tả:\n${t.description}\n\nThư mục dự án: ${t.dir}${overridesText(t)}\n\n` +
    'Hãy đọc code liên quan, lập kế hoạch rồi gọi propose_plan. Sau đó kết thúc lượt.',
  approved: (plan: Plan, worktree: string): string =>
    `Kế hoạch đã được duyệt. Worktree của ticket: ${worktree}\n\nKế hoạch được duyệt (người dùng có thể đã sửa):\n${JSON.stringify(plan, null, 2)}\n\n` +
    'Worktree mới tạo chưa cài dependency: Dev đầu tiên cần cài trong worktree (vd. `npm ci` hoặc `npm install`) trước khi các Dev song song chạy build/test.\n\n' +
    'Hãy giao việc bằng spawn_agent theo các gói, rồi gọi wait_agents và kết thúc lượt.',
  revised: (feedback: string): string =>
    `Người dùng góp ý về kế hoạch:\n${feedback}\n\nHãy sửa kế hoạch theo góp ý rồi gọi lại propose_plan, sau đó kết thúc lượt.`,
  agentsDone: (reports: AgentReport[], round: number, maxRounds: number): string =>
    `Các agent đã xong (vòng ${round}/${maxRounds}). Báo cáo:\n${JSON.stringify(reports, null, 2)}\n\n` +
    'Xem báo cáo. Nếu Dev vừa xong thì giao review (Designer nếu có, QC). Còn lỗi và còn vòng thì giao lại Dev kèm lỗi cụ thể. ' +
    'Đạt mọi tiêu chí thì gọi finish với status "done"; hết vòng mà còn lỗi thì finish với status "escalated".',
  nudge: (): string =>
    'Bạn vừa kết thúc lượt mà không gọi tool chờ (propose_plan, wait_agents) hay finish. ' +
    'Hãy tiếp tục: gọi tool phù hợp, hoặc finish với status "escalated" nếu cần người dùng can thiệp.',
  restarted: (): string =>
    'Dashboard vừa khởi động lại. Các agent đang chạy khi đó bị gián đoạn. Hãy xem lại trạng thái ticket và tiếp tục từ bước còn dở.',
  continued: (guidance: string, maxRounds: number): string =>
    `Người dùng cho ticket tiếp tục (giới hạn mới: ${maxRounds} vòng). Chỉ đạo:\n${guidance}\n\nHãy tiếp tục theo chỉ đạo này.`,
};
