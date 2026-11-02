import type { AgentInfo } from '@/src/core/model';

export interface TreeNode { agent: AgentInfo; depth: number; isLast: boolean; }

const byRecency = (a: AgentInfo, b: AgentInfo): number => b.lastEventAt - a.lastEventAt;

function childrenOf(id: string, all: AgentInfo[]): AgentInfo[] {
  return all.filter((a) => a.parentId === id).sort(byRecency);
}

export function buildRoots(agents: AgentInfo[]): { session: AgentInfo; children: AgentInfo[] }[] {
  const ids = new Set(agents.map((a) => a.id));
  return agents
    .filter((a) => a.parentId === null || !ids.has(a.parentId))
    .sort((a, b) => {
      const ra = a.status === 'running' ? 0 : 1;
      const rb = b.status === 'running' ? 0 : 1;
      return ra - rb || byRecency(a, b);
    })
    .map((session) => ({ session, children: childrenOf(session.id, agents) }));
}

export function flattenTree(root: AgentInfo, all: AgentInfo[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (agent: AgentInfo, depth: number, isLast: boolean, seen: Set<string>): void => {
    out.push({ agent, depth, isLast });
    if (seen.has(agent.id)) return;
    const next = new Set(seen).add(agent.id);
    const kids = childrenOf(agent.id, all);
    kids.forEach((k, i) => walk(k, depth + 1, i === kids.length - 1, next));
  };
  walk(root, 0, true, new Set());
  return out;
}
