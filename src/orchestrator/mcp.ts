export interface ToolResult { text: string; isError?: boolean }
export type ToolImpl = (args: Record<string, unknown>) => Promise<ToolResult>;

const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
const WAIT_NOTE = 'Có thể trả về "đang chờ": khi đó hãy kết thúc lượt ngay, không gọi thêm tool nào và không viết gì thêm; hệ thống sẽ đánh thức lại bạn.';

const roleSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    agent: { type: 'string', enum: ['claude', 'codex'] },
    model: { type: 'string' },
    effort: { type: 'string', enum: EFFORT },
    count: { type: 'integer', minimum: 0 },
  },
  required: ['agent', 'model', 'effort', 'count'],
};

const PLAN_SCHEMA = {
  type: 'object',
  description: 'Kế hoạch của ticket.',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'Tóm tắt hướng làm.' },
    difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
    packages: {
      type: 'array',
      description: 'Các gói việc; gói chạy song song không được trùng file.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          role: { type: 'string', enum: ['explorer', 'dev', 'designer', 'qc'] },
          title: { type: 'string' },
          task: { type: 'string' },
          files: { type: 'array', items: { type: 'string' }, description: 'File/thư mục gói này được sửa.' },
        },
        required: ['id', 'role', 'title', 'task', 'files'],
      },
    },
    roles: {
      type: 'object',
      description: 'Cấu hình cho từng vai.',
      additionalProperties: false,
      properties: { explorer: roleSpec, dev: roleSpec, designer: roleSpec, qc: roleSpec },
      required: ['explorer', 'dev', 'designer', 'qc'],
    },
    acceptance: { type: 'array', items: { type: 'string' }, description: 'Tiêu chí nghiệm thu.' },
    preview: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['dev', 'prod'], description: 'Chế độ server preview cho capture; prod khi tiêu chí nghiệm thu cần SSR, redirect, middleware hay header.' },
      },
      required: ['mode'],
    },
  },
  required: ['summary', 'difficulty', 'packages', 'roles', 'acceptance'],
};

export const USER_ACTION_LIMITS = { title: 120, message: 2000, url: 2000, command: 500 };

const TARGET = { type: 'string', description: 'CSS selector, hoặc text=<chữ>, role=button[name="Lưu"], testid=<id>' };
const STEP_SCHEMA = {
  type: 'object',
  description: 'Đúng một loại bước: goto | click | fill+value | select+value | check(+checked) | press(+target) | upload+file | waitFor | shot(+fullPage,+target) | measure.',
  properties: {
    goto: { type: 'string', description: 'Đường dẫn tương đối trên server preview, bắt đầu bằng / (vd. /workspaces).' },
    click: TARGET, fill: TARGET, select: TARGET, check: TARGET, upload: TARGET,
    value: { type: 'string' },
    checked: { type: 'boolean' },
    press: { type: 'string', description: 'Tên phím, vd. Enter.' },
    target: TARGET,
    file: { type: 'string', description: 'File trong worktree để upload (đường dẫn tương đối).' },
    waitFor: { description: 'Target cần hiện, hoặc { url: "<chuỗi con của URL>" }.', anyOf: [TARGET, { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }] },
    shot: { type: 'string', description: 'Tên ảnh ([A-Za-z0-9_-], ≤ 40 ký tự). Tối đa 6 ảnh mỗi lần gọi.' },
    fullPage: { type: 'boolean' },
    measure: { type: 'array', items: TARGET, minItems: 1, maxItems: 20, description: 'Đo kích thước, vị trí và CSS computed (màu, font, padding, margin, gap, border, radius…).' },
  },
};

const CAPTURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    as: { type: 'string', description: 'Tên tài khoản test (xem prompt). Bỏ trống = khách chưa đăng nhập. Dashboard tự đăng nhập; bạn không cần và không biết mật khẩu.' },
    viewport: { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', minimum: 320, maximum: 1920 }, height: { type: 'integer', minimum: 200, maximum: 4000 } }, description: 'Mặc định 1440×900.' },
    colorScheme: { type: 'string', enum: ['light', 'dark'] },
    locale: { type: 'string', description: 'Accept-Language, vd. vi hoặc en-US.' },
    cookies: { type: 'array', maxItems: 20, items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } }, required: ['name', 'value'] } },
    steps: { type: 'array', minItems: 1, maxItems: 30, items: STEP_SCHEMA },
  },
  required: ['steps'],
};

export const TOOL_DEFS: { name: 'propose_plan' | 'spawn_agent' | 'wait_agents' | 'get_agent_log' | 'finish' | 'request_user_action' | 'capture'; description: string; inputSchema: object }[] = [
  {
    name: 'propose_plan',
    description: `Gửi kế hoạch cho người dùng duyệt trước khi giao việc. ${WAIT_NOTE} Chỉ sau khi được duyệt mới được gọi spawn_agent.`,
    inputSchema: { type: 'object', additionalProperties: false, properties: { plan: PLAN_SCHEMA }, required: ['plan'] },
  },
  {
    name: 'spawn_agent',
    description: 'Giao một gói việc cho subagent (explorer, dev, designer hoặc qc). Explorer chỉ đọc: tìm và đọc file liên quan rồi báo lại để bạn giao Dev. files là phạm vi được sửa (explorer, designer, qc: file cần tập trung); sửa ngoài phạm vi sẽ bị chặn. Trả về id agent để dùng với wait_agents và get_agent_log.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string', enum: ['explorer', 'dev', 'designer', 'qc'] },
        packageId: { type: 'string', description: 'Id gói việc trong kế hoạch.' },
        task: { type: 'string', description: 'Việc cần làm, đủ ngữ cảnh để làm độc lập.' },
        files: { type: 'array', items: { type: 'string' }, description: 'File/thư mục agent được sửa.' },
        contextFrom: {
          type: 'array', items: { type: 'string' }, maxItems: 5,
          description: 'Id các agent đã xong (vd. explorer-1, qc-1) mà báo cáo đầy đủ sẽ được dashboard chèn nguyên văn vào prompt của agent này. Dùng thay cho việc chép báo cáo vào task: task chỉ cần nêu việc phải làm.',
        },
        mode: { type: 'string', enum: ['cases'], description: 'Chỉ với role qc: "cases" = QC viết test case TC-… từ tiêu chí nghiệm thu trước khi Dev làm (chỉ đọc, không capture, không chờ cài dependency). Bỏ trống = QC review như thường.' },
        model: { type: 'string', description: 'Không cần truyền: agent/model/effort luôn theo kế hoạch đã duyệt.' },
        effort: { type: 'string', enum: EFFORT },
        agent: { type: 'string', enum: ['claude', 'codex'] },
      },
      required: ['role', 'task', 'files'],
    },
  },
  {
    name: 'wait_agents',
    description: `Chờ các subagent chạy xong. ${WAIT_NOTE} Khi tất cả đã xong, kết quả của từng agent được trả về.`,
    inputSchema: { type: 'object', additionalProperties: false, properties: { ids: { type: 'array', items: { type: 'string' } } }, required: ['ids'] },
  },
  {
    name: 'get_agent_log',
    description: 'Xem các bước gần đây của một subagent (tool đã gọi, lỗi) để kiểm tra nó làm gì.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
      required: ['id'],
    },
  },
  {
    name: 'finish',
    description: 'Kết thúc ticket với báo cáo cuối. status=done khi đạt tiêu chí nghiệm thu, escalated khi cần người dùng can thiệp.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { report: { type: 'string' }, status: { type: 'string', enum: ['done', 'escalated'] } },
      required: ['report', 'status'],
    },
  },
  {
    name: 'request_user_action',
    description:
      'Nhờ người dùng làm việc bạn không tự làm được: đăng nhập (CLI, trình duyệt, SSO, OTP), mở một link, cấp quyền, chạy lệnh cần terminal thật. ' +
      'Dashboard hiện hộp thoại cho người dùng kèm link và lệnh. Sau khi gọi, hãy kết thúc lượt ngay; khi người dùng trả lời, bạn được gọi lại trong cùng phiên để làm tiếp.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', maxLength: USER_ACTION_LIMITS.title, description: 'Việc cần làm, ngắn (vd. "Đăng nhập twg").' },
        message: { type: 'string', maxLength: USER_ACTION_LIMITS.message, description: 'Hướng dẫn từng bước cho người dùng.' },
        url: { type: 'string', maxLength: USER_ACTION_LIMITS.url, description: 'Link http(s) người dùng cần mở, nếu có.' },
        command: { type: 'string', maxLength: USER_ACTION_LIMITS.command, description: 'Lệnh người dùng cần tự chạy trong terminal của họ, nếu có.' },
      },
      required: ['title', 'message'],
    },
  },
  {
    name: 'capture',
    description:
      'Mở trang của ticket trong Chrome headless trên server preview do dashboard quản lý (đăng nhập theo tên tài khoản test nếu có `as`), chạy các bước, ' +
      'trả ảnh (đường dẫn PNG để Read), số đo DOM, URL, console, request ghi. Không tự bật server hay trình duyệt. ' +
      'Lần đầu có thể mất tới vài phút để bật/build server. Lỗi bắt đầu bằng [capture:<mã>].',
    inputSchema: CAPTURE_SCHEMA,
  },
];

type Resp = Record<string, unknown>;
const err = (id: unknown, code: number, message: string): Resp => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function one(msg: unknown, tools: Record<string, ToolImpl>): Promise<Resp | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return err(null, -32600, 'Request không hợp lệ');
  const m = msg as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  if (m.id === undefined || m.id === null) return null;
  const id = m.id;
  const params = m.params && typeof m.params === 'object' ? m.params : {};
  switch (m.method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: { protocolVersion: (params.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'acctv', version: '0.2.0' } } };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      // chỉ liệt kê tool mà phía gọi được dùng (Controller hoặc worker)
      return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFS.filter((d) => Object.prototype.hasOwnProperty.call(tools, d.name)) } };
    case 'tools/call': {
      const name = String(params.name ?? '');
      const impl = Object.prototype.hasOwnProperty.call(tools, name) ? tools[name] : undefined;
      if (!impl) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Tool không tồn tại: ${name}` }], isError: true } };
      try {
        const r = await impl((params.arguments as Record<string, unknown>) ?? {});
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], isError: !!r.isError } };
      } catch (e) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true } };
      }
    }
    default:
      return err(id, -32601, `Method không tồn tại: ${String(m.method)}`);
  }
}

export async function handleMcp(body: unknown, tools: Record<string, ToolImpl>): Promise<{ status: 200 | 202; json?: unknown }> {
  if (Array.isArray(body)) {
    if (!body.length) return { status: 200, json: err(null, -32600, 'Request không hợp lệ') };
    const out = (await Promise.all(body.map(b => one(b, tools)))).filter((x): x is Resp => x !== null);
    return out.length ? { status: 200, json: out } : { status: 202 };
  }
  const r = await one(body, tools);
  return r ? { status: 200, json: r } : { status: 202 };
}
