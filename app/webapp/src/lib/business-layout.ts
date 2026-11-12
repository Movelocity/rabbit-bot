export interface BusinessLayoutNode {
  id: string;
  type: string;
  x: number;
  y: number;
}

export interface BusinessLayoutEdge {
  from: string;
  to: string;
}

export const BUSINESS_NODE_SIZE = 96;

const NODE_RADIUS = BUSINESS_NODE_SIZE / 2;
const TREE_GAP_X = 150;
const TREE_GAP_Y = 170;
const TREE_SPRING_LENGTH = 170;
const TREE_CENTER_STRENGTH = 0.045;
const TREE_SPRING_STRENGTH = 0.08;
const TYPE_COHESION = 0.018;
const TREE_RELAX_ITERATIONS = 180;
const COMPONENT_GAP = 96;
const GROUP_GAP = 52;
const NODE_GAP = 42;
const MARGIN = NODE_RADIUS + 40;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

interface Point {
  x: number;
  y: number;
}

interface TreeLayout {
  ids: string[];
  positions: Map<string, Point>;
  parents: Map<string, string | null>;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  offsetX: number;
  offsetY: number;
}

interface Rect {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

function rectsOverlap(a: Rect, b: Rect, padding: number): boolean {
  return (
    Math.abs(a.centerX - b.centerX) < (a.width + b.width) / 2 + padding &&
    Math.abs(a.centerY - b.centerY) < (a.height + b.height) / 2 + padding
  );
}

function findComponentOffset(
  tree: TreeLayout,
  placed: Rect[],
): { centerX: number; centerY: number } {
  for (let attempt = 0; attempt < 6000; attempt++) {
    const radius = 8 * Math.sqrt(attempt) + attempt * 1.8;
    const angle = attempt * GOLDEN_ANGLE;
    const candidate: Rect = {
      centerX: Math.cos(angle) * radius,
      centerY: Math.sin(angle) * radius,
      width: tree.width,
      height: tree.height,
    };
    if (!placed.some((other) => rectsOverlap(candidate, other, COMPONENT_GAP))) {
      return { centerX: candidate.centerX, centerY: candidate.centerY };
    }
  }

  const last = placed[placed.length - 1];
  return {
    centerX: (last?.centerX ?? 0) + (last?.width ?? 0) / 2 + tree.width / 2 + COMPONENT_GAP,
    centerY: last?.centerY ?? 0,
  };
}

function relaxTreeLayout(
  ids: string[],
  parents: Map<string, string | null>,
  initial: Map<string, Point>,
  types: Map<string, string>,
  splitByType: boolean,
): { positions: Map<string, Point>; width: number; height: number } {
  const positions = new Map<string, Point>();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const point = initial.get(id) ?? { x: 0, y: 0 };
    positions.set(id, { x: point.x, y: point.y });
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const minDistance = BUSINESS_NODE_SIZE + NODE_GAP;
  const groupDistance = minDistance + GROUP_GAP;
  const nodeTypes = ids.map((id) => types.get(id) ?? "");
  const edges = [...parents.entries()].filter((entry): entry is [string, string] => !!entry[1]);
  const points = ids.map((id) => positions.get(id)!);

  for (let iteration = 0; iteration < TREE_RELAX_ITERATIONS; iteration++) {
    for (const point of points) {
      point.x += (centerX - point.x) * TREE_CENTER_STRENGTH;
      point.y += (centerY - point.y) * TREE_CENTER_STRENGTH;
    }

    if (splitByType) {
      const sums = new Map<string, { x: number; y: number; count: number }>();
      ids.forEach((id, index) => {
        const type = nodeTypes[index];
        const point = points[index];
        const sum = sums.get(type) ?? { x: 0, y: 0, count: 0 };
        sum.x += point.x;
        sum.y += point.y;
        sum.count += 1;
        sums.set(type, sum);
      });
      ids.forEach((id, index) => {
        const sum = sums.get(nodeTypes[index]);
        if (!sum) return;
        const point = points[index];
        point.x += (sum.x / sum.count - point.x) * TYPE_COHESION;
        point.y += (sum.y / sum.count - point.y) * TYPE_COHESION;
      });
    }

    for (const [id, parentId] of edges) {
      const child = positions.get(id);
      const parent = positions.get(parentId);
      if (!child || !parent) continue;
      const dx = parent.x - child.x;
      const dy = parent.y - child.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 0.001) continue;
      const ux = dx / distance;
      const uy = dy / distance;
      const force = (distance - TREE_SPRING_LENGTH) * TREE_SPRING_STRENGTH * 0.5;
      child.x += ux * force;
      child.y += uy * force;
      parent.x -= ux * force;
      parent.y -= uy * force;
    }

    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      for (let j = i + 1; j < points.length; j++) {
        const b = points[j];
        const distanceLimit =
          splitByType && nodeTypes[i] !== nodeTypes[j] ? groupDistance : minDistance;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= distanceLimit) continue;
        const ux = distance > 0.001 ? dx / distance : 1;
        const uy = distance > 0.001 ? dy / distance : 0;
        const push = (distanceLimit - distance) / 2;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
      }
    }
  }

  let finalMinX = Infinity;
  let finalMinY = Infinity;
  let finalMaxX = -Infinity;
  let finalMaxY = -Infinity;
  for (const point of points) {
    finalMinX = Math.min(finalMinX, point.x);
    finalMinY = Math.min(finalMinY, point.y);
    finalMaxX = Math.max(finalMaxX, point.x);
    finalMaxY = Math.max(finalMaxY, point.y);
  }
  for (const point of points) {
    point.x -= finalMinX;
    point.y -= finalMinY;
  }
  return {
    positions,
    width: Math.max(0, finalMaxX - finalMinX),
    height: Math.max(0, finalMaxY - finalMinY),
  };
}

function relaxNodeOverlaps(nodes: BusinessLayoutNode[]): void {
  const minDistance = BUSINESS_NODE_SIZE + NODE_GAP;
  for (let iteration = 0; iteration < 60; iteration++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const ax = a.x + NODE_RADIUS;
      const ay = a.y + NODE_RADIUS;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const bx = b.x + NODE_RADIUS;
        const by = b.y + NODE_RADIUS;
        const dx = bx - ax;
        const dy = by - ay;
        const distance = Math.hypot(dx, dy);
        if (distance >= minDistance) continue;
        moved = true;
        const ux = distance > 0.001 ? dx / distance : 1;
        const uy = distance > 0.001 ? dy / distance : 0;
        const push = (minDistance - distance) / 2;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
      }
    }
    if (!moved) break;
  }
}

/**
 * 先按连通分量生成 BFS 树并在组内做紧凑树布局，再把每棵树的包围盒当作泡泡
 * 用黄金角螺旋铺开，最后做一轮节点圆碰撞，保证节点之间至少留一条缝。
 */
export function layoutBusinessGraph(
  nodes: BusinessLayoutNode[],
  edges: BusinessLayoutEdge[],
): void {
  if (!nodes.length) return;

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const types = new Map(nodes.map((node) => [node.id, node.type]));
  const typeCounts = new Set(types.values()).size;
  const splitByType = typeCounts > 1 && typeCounts <= 12;
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    const from = adjacency.get(edge.from);
    const to = adjacency.get(edge.to);
    if (!from || !to) continue;
    from.add(edge.to);
    to.add(edge.from);
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const node of nodes) {
    if (visited.has(node.id)) continue;
    const members: string[] = [];
    const queue = [node.id];
    visited.add(node.id);
    while (queue.length) {
      const id = queue.shift()!;
      members.push(id);
      for (const next of adjacency.get(id) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    components.push(members);
  }

  const trees: TreeLayout[] = [];
  for (const members of components) {
    let root = members[0];
    let bestDegree = -1;
    for (const id of members) {
      const degree = adjacency.get(id)?.size ?? 0;
      if (degree > bestDegree || (degree === bestDegree && id < root)) {
        bestDegree = degree;
        root = id;
      }
    }

    const children = new Map<string, string[]>();
    const parents = new Map<string, string | null>();
    const depths = new Map<string, number>();
    const ids: string[] = [];
    const queue = [root];
    const seen = new Set([root]);
    depths.set(root, 0);
    parents.set(root, null);
    while (queue.length) {
      const id = queue.shift()!;
      ids.push(id);
      const kids = [...(adjacency.get(id) ?? [])]
        .filter((next) => !seen.has(next))
        .sort((a, b) => {
          const nodeA = byId.get(a);
          const nodeB = byId.get(b);
          const typeOrder = (nodeA?.type ?? "").localeCompare(nodeB?.type ?? "");
          return typeOrder !== 0 ? typeOrder : a.localeCompare(b);
        });
      children.set(id, kids);
      for (const next of kids) {
        seen.add(next);
        parents.set(next, id);
        depths.set(next, (depths.get(id) ?? 0) + 1);
        queue.push(next);
      }
    }

    const xs = new Map<string, number>();
    let cursor = 0;
    const assign = (id: string): number => {
      const kids = children.get(id) ?? [];
      if (!kids.length) {
        const x = cursor * TREE_GAP_X;
        cursor += 1;
        xs.set(id, x);
        return x;
      }
      let first = 0;
      let last = 0;
      kids.forEach((kid, index) => {
        const x = assign(kid);
        if (index === 0) first = x;
        last = x;
      });
      const x = (first + last) / 2;
      xs.set(id, x);
      return x;
    };
    assign(root);

    let minX = Infinity;
    for (const id of ids) minX = Math.min(minX, xs.get(id) ?? 0);
    const initial = new Map<string, Point>();
    for (const id of ids) {
      initial.set(id, {
        x: (xs.get(id) ?? 0) - minX,
        y: (depths.get(id) ?? 0) * TREE_GAP_Y,
      });
    }
    const { positions, width, height } = relaxTreeLayout(
      ids,
      parents,
      initial,
      types,
      splitByType,
    );

    trees.push({
      ids,
      positions,
      parents,
      width,
      height,
      centerX: 0,
      centerY: 0,
      offsetX: 0,
      offsetY: 0,
    });
  }

  const ordered = [...trees].sort(
    (a, b) =>
      Math.hypot(b.width, b.height) - Math.hypot(a.width, a.height) ||
      b.ids.length - a.ids.length,
  );
  const placed: Rect[] = [];
  for (const tree of ordered) {
    const center = placed.length ? findComponentOffset(tree, placed) : { centerX: 0, centerY: 0 };
    tree.centerX = center.centerX;
    tree.centerY = center.centerY;
    tree.offsetX = center.centerX - tree.width / 2;
    tree.offsetY = center.centerY - tree.height / 2;
    placed.push({
      centerX: center.centerX,
      centerY: center.centerY,
      width: tree.width,
      height: tree.height,
    });
  }

  for (const tree of ordered) {
    for (const id of tree.ids) {
      const node = byId.get(id);
      const point = tree.positions.get(id);
      if (!node || !point) continue;
      node.x = tree.offsetX + point.x - NODE_RADIUS;
      node.y = tree.offsetY + point.y - NODE_RADIUS;
    }
  }

  relaxNodeOverlaps(nodes);

  let minLeft = Infinity;
  let minTop = Infinity;
  for (const node of nodes) {
    minLeft = Math.min(minLeft, node.x);
    minTop = Math.min(minTop, node.y);
  }
  for (const node of nodes) {
    node.x += MARGIN - minLeft;
    node.y += MARGIN - minTop;
  }
}
