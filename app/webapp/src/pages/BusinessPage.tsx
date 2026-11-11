import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useApi } from "../lib/api-context.tsx";
import {
  businessObjectName,
  businessRelationName,
  businessTypeName,
  friendlyError,
  relationRiskVariant,
} from "../lib/format.ts";
import { cx } from "../lib/cx.ts";
import { ALL_GRAPHS, DEFAULT_GRAPH, collectGraphIds, filterByGraph } from "../lib/business-graph.ts";
import type {
  BusinessCategory,
  BusinessData,
  BusinessEdge,
  BusinessLintReport,
  BusinessSelection,
  BusinessRelation,
} from "../lib/types.ts";
import {
  Badge,
  Button,
  Empty,
  Input,
  Select,
  StatusText,
} from "../components/ui.tsx";
import { Drawer } from "../components/Drawer.tsx";
import { Modal } from "../components/Modal.tsx";
import { DetailRows, type DetailRow } from "../components/DetailRows.tsx";

const CATEGORIES: { id: BusinessCategory; label: string }[] = [
  { id: "objects", label: "对象" },
  { id: "relations", label: "关系" },
  { id: "actions", label: "动作" },
  { id: "terms", label: "术语" },
  { id: "types", label: "类型" },
];

const TYPE_COLORS = [
  "#2563eb",
  "#16a34a",
  "#db2777",
  "#f59e0b",
  "#7c3aed",
  "#0891b2",
  "#dc2626",
  "#4d7c0f",
  "#b45309",
  "#0f766e",
];

const CATEGORY_COLORS: Record<BusinessCategory, string> = {
  objects: "#2563eb",
  relations: "#0891b2",
  actions: "#16a34a",
  terms: "#db2777",
  types: "#f59e0b",
};

interface BusinessItem {
  kind: BusinessCategory;
  id: string;
  title: string;
  subtitle: string;
}

function businessItemsFor(
  data: BusinessData,
  category: BusinessCategory,
  q: string,
): BusinessItem[] {
  const hit = (...vals: (string | undefined)[]) =>
    !q || vals.filter(Boolean).join(" ").toLowerCase().includes(q);

  if (category === "objects") {
    return data.objects
      .filter((o) =>
        hit(o.id, o.type, o.name, ...(o.aliases || []), o.description, ...(o.tags || [])),
      )
      .map((o) => ({
        kind: "objects",
        id: o.id,
        title: o.name || o.id,
        subtitle: `${businessTypeName(data, o.type)} · ${o.id}`,
      }));
  }
  if (category === "relations") {
    return data.relations
      .filter((r) => hit(r.id, r.name, r.fromType, r.toType, r.semantics))
      .map((r) => ({
        kind: "relations",
        id: r.id,
        title: `${businessTypeName(data, r.fromType)} → ${businessTypeName(data, r.toType)}`,
        subtitle: `${r.name || r.id} · ${r.edge_count ?? 0} 条边`,
      }));
  }
  if (category === "actions") {
    return data.actions
      .filter((a) =>
        hit(a.id, a.name, a.description, ...(a.appliesTo || []), ...(a.requiresRelations || [])),
      )
      .map((a) => ({
        kind: "actions",
        id: a.id,
        title: a.name || a.id,
        subtitle: `${(a.appliesTo || []).map((t) => businessTypeName(data, t)).join(" / ") || "未限定类型"}${a.risk ? ` · ${a.risk}` : ""}`,
      }));
  }
  if (category === "terms") {
    return data.terms
      .filter((t) => hit(t.term, t.objectId, t.note))
      .map((t) => ({
        kind: "terms",
        id: t.term,
        title: t.term,
        subtitle: `${t.objectId}${t.note ? ` · ${t.note}` : ""}`,
      }));
  }
  const typeCounts = new Map<string, number>();
  for (const o of data.objects) typeCounts.set(o.type, (typeCounts.get(o.type) || 0) + 1);
  return data.types
    .filter((t) => hit(t.id, t.name, t.description))
    .map((t) => ({
      kind: "types",
      id: t.id,
      title: t.name || t.id,
      subtitle: `${t.id} · ${typeCounts.get(t.id) || 0} 个对象`,
    }));
}

function categoryLabel(id: BusinessCategory): string {
  return CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

function BusinessLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="border-0 bg-transparent p-0 text-left wrap-anywhere text-accent hover:underline"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Subhead({ children }: { children: ReactNode }) {
  return <h4 className="mb-0.5 mt-4 text-[13px] font-semibold text-muted">{children}</h4>;
}

function BugIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="M8 5.2a3 3 0 0 1 3 3v.7a3 3 0 1 1-6 0v-.7a3 3 0 0 1 3-3Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8 5.2V3.4M5.9 5.9 4.7 4.7M10.1 5.9l1.2-1.2M5 8.2H2.9M13.1 8.2H11M5.1 10.3l-1.5.9M10.9 10.3l1.5.9M6.8 11.9l-.7 1.4M9.2 11.9l.7 1.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EdgeRow({
  data,
  edge,
  selectedId,
  onSelect,
}: {
  data: BusinessData;
  edge: BusinessEdge;
  selectedId: string;
  onSelect: (kind: BusinessCategory, id: string) => void;
}) {
  const outgoing = edge.from === selectedId;
  const other = outgoing ? edge.to : edge.from;
  return (
    <div className="flex items-baseline gap-2 border-t border-dashed border-border py-1.5 text-[13px] wrap-anywhere first:border-t-0">
      <span className="flex-none text-muted">{outgoing ? "→" : "←"}</span>
      <span>{businessRelationName(data, edge.relation)}</span>
      <BusinessLink onClick={() => onSelect("objects", other)}>
        {businessObjectName(data, other)}
      </BusinessLink>
    </div>
  );
}

function BusinessDetail({
  data,
  selection,
  onSelect,
  onFocus,
}: {
  data: BusinessData | null;
  selection: BusinessSelection | null;
  onSelect: (kind: BusinessCategory, id: string) => void;
  onFocus?: (id: string) => void;
}) {
  if (!data || !data.exists) {
    return <p className="mx-auto my-8 max-w-[320px] text-center text-[13px] text-muted">还没有知识数据。</p>;
  }
  if (!selection) {
    return (
      <p className="mx-auto my-8 max-w-[320px] text-center text-[13px] text-muted">
        选一个条目看详情，或切到关系图点节点。
      </p>
    );
  }

  const typeName = (id: string) => businessTypeName(data, id);
  const objName = (id: string) => businessObjectName(data, id);
  const relName = (id: string) => businessRelationName(data, id);
  const rows = (list: DetailRow[]) => <DetailRows rows={list} />;
  const head = (title: string, badge?: ReactNode) => (
    <div className="flex items-start justify-between gap-2.5">
      <h3 className="m-0 text-[17px] font-semibold wrap-anywhere">{title}</h3>
      {badge}
    </div>
  );
  const body = (text?: string) =>
    text ? <div className="mt-2.5 whitespace-pre-wrap text-sm wrap-anywhere">{text}</div> : null;
  const linkLine = (label: string, onClick: () => void, extra?: ReactNode) => (
    <div className="flex items-baseline gap-2 border-t border-dashed border-border py-1.5 text-[13px] wrap-anywhere first:border-t-0">
      <BusinessLink onClick={onClick}>{label}</BusinessLink>
      {extra}
    </div>
  );

  if (selection.kind === "objects") {
    const o = data.objects.find((x) => x.id === selection.id);
    if (!o) return <p className="text-[13px] text-muted">对象 {selection.id} 不存在。</p>;
    const edges = data.edges.filter((e) => e.from === o.id || e.to === o.id);
    const actions = data.actions.filter((a) => (a.appliesTo || []).includes(o.type));
    const terms = data.terms.filter((t) => t.objectId === o.id);
    return (
      <>
        {head(o.name || o.id, <Badge variant="info">{typeName(o.type)}</Badge>)}
        {onFocus && (
          <div className="mt-2">
            <Button size="sm" variant="ghost" onClick={() => onFocus(o.id)}>
              在关系图中聚焦
            </Button>
          </div>
        )}
        {body(o.description)}
        {rows([
          { label: "id", value: o.id, mono: true },
          { label: "type", value: `${typeName(o.type)}（${o.type}）` },
          { label: "别名", value: (o.aliases || []).join(" / ") },
          {
            label: "key",
            value: o.key?.value ? `${o.key.kind ? `${o.key.kind}:` : ""}${o.key.value}` : "",
            mono: true,
          },
          {
            label: "source",
            value: o.source?.value
              ? `${o.source.kind ? `${o.source.kind}:` : ""}${o.source.value}`
              : "",
            mono: true,
          },
          { label: "tags", value: (o.tags || []).join(" / ") },
        ])}
        <Subhead>关系（{edges.length}）</Subhead>
        {!edges.length ? (
          <p className="text-sm text-muted">没有解析出边。</p>
        ) : (
          <div>
            {edges.map((e, i) => (
              <EdgeRow key={i} data={data} edge={e} selectedId={o.id} onSelect={onSelect} />
            ))}
          </div>
        )}
        {actions.length > 0 && (
          <>
            <Subhead>动作（{actions.length}）</Subhead>
            <div>
              {actions.map((a) =>
                linkLine(
                  a.name || a.id,
                  () => onSelect("actions", a.id),
                  a.risk ? <Badge>{a.risk}</Badge> : undefined,
                ),
              )}
            </div>
          </>
        )}
        {terms.length > 0 && (
          <>
            <Subhead>术语（{terms.length}）</Subhead>
            <div>
              {terms.map((t) => (
                <div
                  key={t.term}
                  className="flex items-baseline gap-2 border-t border-dashed border-border py-1.5 text-[13px] wrap-anywhere first:border-t-0"
                >
                  <span>{t.term}</span>
                  {t.note && <span className="text-muted">{t.note}</span>}
                </div>
              ))}
            </div>
          </>
        )}
      </>
    );
  }

  if (selection.kind === "relations") {
    const r = data.relations.find((x) => x.id === selection.id);
    if (!r) return <p className="text-[13px] text-muted">关系 {selection.id} 不存在。</p>;
    const edges = data.edges.filter((e) => e.relation === r.id);
    return (
      <>
        {head(
          `${typeName(r.fromType)} → ${typeName(r.toType)}`,
          r.risk ? <Badge variant={relationRiskVariant(r.risk)}>{r.risk}</Badge> : undefined,
        )}
        {body(r.semantics)}
        {rows([
          { label: "id", value: r.id, mono: true },
          { label: "name", value: r.name },
          { label: "from", value: `${typeName(r.fromType)}（${r.fromType}）` },
          { label: "to", value: `${typeName(r.toType)}（${r.toType}）` },
          { label: "cardinality", value: r.cardinality || "" },
          { label: "direction", value: r.direction || "" },
          {
            label: "mapping",
            value: r.mapping?.kind
              ? `${r.mapping.kind}${r.mapping.file ? ` · ${r.mapping.file}` : ""}`
              : "",
            mono: true,
          },
        ])}
        <Subhead>实际边（{edges.length}）</Subhead>
        {!edges.length ? (
          <p className="text-sm text-muted">没有边：这条关系还没写入对象实例。</p>
        ) : (
          <div>
            {edges.map((e, i) => (
              <div
                key={i}
                className="flex items-baseline gap-2 border-t border-dashed border-border py-1.5 text-[13px] wrap-anywhere first:border-t-0"
              >
                <BusinessLink onClick={() => onSelect("objects", e.from)}>
                  {objName(e.from)}
                </BusinessLink>
                <span className="text-muted">→</span>
                <BusinessLink onClick={() => onSelect("objects", e.to)}>
                  {objName(e.to)}
                </BusinessLink>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  if (selection.kind === "actions") {
    const a = data.actions.find((x) => x.id === selection.id);
    if (!a) return <p className="text-[13px] text-muted">动作 {selection.id} 不存在。</p>;
    return (
      <>
        {head(
          a.name || a.id,
          a.risk ? <Badge variant={relationRiskVariant(a.risk)}>{a.risk}</Badge> : undefined,
        )}
        {body(a.description)}
        {rows([
          { label: "id", value: a.id, mono: true },
          {
            label: "appliesTo",
            value: (a.appliesTo || []).map((t) => typeName(t)).join(" / "),
          },
          {
            label: "requiresRelations",
            value: (a.requiresRelations || []).map((id) => `${relName(id)}（${id}）`).join(" / "),
          },
        ])}
      </>
    );
  }

  if (selection.kind === "terms") {
    const t = data.terms.find((x) => x.term === selection.id);
    if (!t) return <p className="text-[13px] text-muted">术语 {selection.id} 不存在。</p>;
    return (
      <>
        {head(t.term, <Badge variant="info">{objName(t.objectId)}</Badge>)}
        {body(t.note)}
        {rows([{ label: "objectId", value: t.objectId, mono: true }])}
        <div className="mt-2.5">
          <BusinessLink onClick={() => onSelect("objects", t.objectId)}>查看对象详情</BusinessLink>
        </div>
      </>
    );
  }

  const t = data.types.find((x) => x.id === selection.id);
  if (!t) return <p className="text-[13px] text-muted">类型 {selection.id} 不存在。</p>;
  const objects = data.objects.filter((o) => o.type === t.id);
  const relations = data.relations.filter((r) => r.fromType === t.id || r.toType === t.id);
  return (
    <>
      {head(t.name || t.id, <Badge variant="info">{objects.length} 个对象</Badge>)}
      {body(t.description)}
      {rows([
        { label: "id", value: t.id, mono: true },
        { label: "relations", value: String(relations.length) },
      ])}
      {objects.length > 0 && (
        <>
          <Subhead>对象（{objects.length}）</Subhead>
          <div>
            {objects.map((o) =>
              linkLine(o.name || o.id, () => onSelect("objects", o.id)),
            )}
          </div>
        </>
      )}
      {relations.length > 0 && (
        <>
          <Subhead>关系（{relations.length}）</Subhead>
          <div>
            {relations.map((r) =>
              linkLine(
                `${typeName(r.fromType)} → ${typeName(r.toType)}（${r.name || r.id}）`,
                () => onSelect("relations", r.id),
              ),
            )}
          </div>
        </>
      )}
    </>
  );
}

interface GraphNode {
  id: string;
  name: string;
  type: string;
  search: string;
  x: number;
  y: number;
}

interface BusinessNodeData extends Record<string, unknown> {
  label: string;
  typeLabel: string;
  color: string;
  dim: boolean;
  hot: boolean;
  near: boolean;
}

type BusinessFlowNode = Node<BusinessNodeData, "business">;

interface GraphFocusRequest {
  id: string;
  nonce: number;
}

const NODE_SIZE = 96;
const NODE_RADIUS = NODE_SIZE / 2;
const ARROW_GAP = 12;

const TREE_GAP_X = 145;
const TREE_GAP_Y = 175;

interface TreeComponent {
  ids: string[];
  xs: Map<string, number>;
  depths: Map<string, number>;
  spanX: number;
  spanY: number;
  offsetX: number;
  offsetY: number;
}

function layoutGraph(
  nodes: GraphNode[],
  edges: BusinessEdge[],
  width: number,
  _height: number,
): void {
  if (!nodes.length) return;

  const byId = new Map(nodes.map((node) => [node.id, node]));
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

  const trees: TreeComponent[] = [];
  for (const members of components) {
    let root = members[0];
    let bestDegree = -1;
    for (const id of members) {
      const degree = adjacency.get(id)?.size ?? 0;
      if (degree > bestDegree) {
        bestDegree = degree;
        root = id;
      }
    }

    const children = new Map<string, string[]>();
    const depths = new Map<string, number>();
    const ids: string[] = [];
    const queue = [root];
    const seen = new Set([root]);
    depths.set(root, 0);
    while (queue.length) {
      const id = queue.shift()!;
      ids.push(id);
      children.set(id, []);
      for (const next of adjacency.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        depths.set(next, (depths.get(id) ?? 0) + 1);
        children.get(id)!.push(next);
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

    let maxDepth = 0;
    for (const id of ids) maxDepth = Math.max(maxDepth, depths.get(id) ?? 0);
    trees.push({
      ids,
      xs,
      depths,
      spanX: Math.max(0, cursor - 1) * TREE_GAP_X,
      spanY: maxDepth * TREE_GAP_Y,
      offsetX: 0,
      offsetY: 0,
    });
  }

  const targetWidth = Math.max(width, TREE_GAP_X * 4);
  const ordered = [...trees].sort((a, b) => b.spanX - a.spanX || b.spanY - a.spanY);
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const tree of ordered) {
    if (cursorX > 0 && cursorX + tree.spanX > targetWidth) {
      cursorX = 0;
      cursorY += rowHeight + TREE_GAP_Y;
      rowHeight = 0;
    }
    tree.offsetX = cursorX;
    tree.offsetY = cursorY;
    cursorX += tree.spanX + TREE_GAP_X;
    rowHeight = Math.max(rowHeight, tree.spanY);
  }

  for (const tree of ordered) {
    for (const id of tree.ids) {
      const node = byId.get(id);
      if (!node) continue;
      node.x = tree.offsetX + (tree.xs.get(id) ?? 0) - NODE_RADIUS;
      node.y = tree.offsetY + (tree.depths.get(id) ?? 0) * TREE_GAP_Y - NODE_RADIUS;
    }
  }
}

function BusinessNodeView({ data }: NodeProps<BusinessFlowNode>) {
  return (
    <div
      title={`${data.label}（${data.typeLabel}）`}
      className={cx(
        "relative flex h-full w-full items-center justify-center overflow-hidden rounded-full border-2 text-center text-white shadow-[var(--rb-shadow)] transition",
        data.hot
          ? "border-accent ring-4 ring-accent/30"
          : data.near
            ? "border-white/70"
            : "border-transparent",
        data.dim ? "opacity-25" : "opacity-100",
      )}
      style={{ backgroundColor: data.color }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="rb-flow-handle"
        style={{ left: "50%", top: "50%" }}
      />
      <span className="line-clamp-2 px-2 text-[12px] font-semibold leading-[1.25] wrap-anywhere">
        {data.label}
      </span>
      <Handle
        type="source"
        position={Position.Top}
        className="rb-flow-handle"
        style={{ left: "50%", top: "50%" }}
      />
    </div>
  );
}

const NODE_TYPES = { business: BusinessNodeView };

function BusinessEdgeView({
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  label,
  markerEnd,
}: EdgeProps) {
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return null;
  const ux = dx / dist;
  const uy = dy / dist;
  const shrink = Math.min(NODE_RADIUS + ARROW_GAP, dist * 0.8);
  const endX = targetX - ux * shrink;
  const endY = targetY - uy * shrink;
  const midX = (sourceX + endX) / 2;
  const midY = (sourceY + endY) / 2;
  return (
    <>
      <path
        d={`M ${sourceX},${sourceY} L ${endX},${endY}`}
        fill="none"
        style={style}
        markerEnd={markerEnd}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)`,
              pointerEvents: "none",
            }}
            className="rounded-[4px] border border-border/60 bg-surface/90 px-1 py-px text-[11px] leading-tight text-muted shadow-sm"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const EDGE_TYPES = { business: BusinessEdgeView };

function BusinessGraphInner({
  data,
  typeColors,
  selection,
  query,
  focusRequest,
  onSelect,
  onClearSelection,
}: {
  data: BusinessData;
  typeColors: Map<string, string>;
  selection: BusinessSelection | null;
  query: string;
  focusRequest: GraphFocusRequest | null;
  onSelect: (kind: BusinessCategory, id: string) => void;
  onClearSelection: () => void;
}) {
  const { fitView, setCenter } = useReactFlow();
  const selectedId = selection?.kind === "objects" ? selection.id : null;

  const graph = useMemo(() => {
    const objects = data.objects.slice(0, 160);
    const byId = new Map(objects.map((o) => [o.id, o]));
    const edges = data.edges.filter((e) => byId.has(e.from) && byId.has(e.to));
    const nodes: GraphNode[] = objects.map((o) => ({
      id: o.id,
      name: o.name || o.id,
      type: o.type,
      search: [o.id, o.type, o.name, ...(o.aliases || []), ...(o.tags || [])]
        .join(" ")
        .toLowerCase(),
      x: 0,
      y: 0,
    }));
    const size = Math.max(1, nodes.length);
    const width = Math.min(3600, Math.max(1100, Math.sqrt(size * 96000)));
    const height = Math.max(620, width / 2);
    layoutGraph(nodes, edges, width, height);
    return { objects, edges, nodes, nodeById: new Map(nodes.map((n) => [n.id, n])) };
  }, [data]);

  const centerOn = useCallback(
    (id: string, zoom: number, duration: number) => {
      const node = graph.nodeById.get(id);
      if (!node) return;
      void setCenter(node.x + NODE_RADIUS, node.y + NODE_RADIUS, { zoom, duration });
    },
    [graph, setCenter],
  );

  const neighbors = useMemo(() => {
    const set = new Set<string>();
    if (!selectedId) return set;
    for (const edge of graph.edges) {
      if (edge.from === selectedId) set.add(edge.to);
      if (edge.to === selectedId) set.add(edge.from);
    }
    return set;
  }, [graph, selectedId]);

  const nodes = useMemo<BusinessFlowNode[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: "business",
        position: { x: node.x, y: node.y },
        width: NODE_SIZE,
        height: NODE_SIZE,
        ariaLabel: `${node.name}（${businessTypeName(data, node.type)}）`,
        data: {
          label: node.name,
          typeLabel: businessTypeName(data, node.type),
          color: typeColors.get(node.type) ?? TYPE_COLORS[0],
          dim: !!query && !node.search.includes(query) && selectedId !== node.id,
          hot: selectedId === node.id,
          near: neighbors.has(node.id),
        },
      })),
    [graph, data, typeColors, query, selectedId, neighbors],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge, index) => {
        const source = graph.nodeById.get(edge.from);
        const target = graph.nodeById.get(edge.to);
        const hot = !!selectedId && (edge.from === selectedId || edge.to === selectedId);
        const dim =
          !!query &&
          !hot &&
          !(source?.search.includes(query) || target?.search.includes(query));
        const color = hot
          ? "var(--rb-accent)"
          : "color-mix(in srgb, var(--rb-muted) 45%, transparent)";
        return {
          id: `${edge.from}->${edge.to}:${index}`,
          source: edge.from,
          target: edge.to,
          type: "business",
          selectable: false,
          focusable: false,
          interactionWidth: 0,
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color },
          style: {
            stroke: color,
            strokeWidth: hot ? 2 : 1.2,
            opacity: dim ? 0.12 : 1,
          },
          label:
            graph.edges.length <= 28 ? edge.relation_name || edge.relation : undefined,
        };
      }),
    [graph, selectedId, query],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (selectedId && graph.nodeById.has(selectedId)) {
        centerOn(selectedId, 0.9, 0);
      } else {
        void fitView({ padding: 0.16, duration: 0, minZoom: 0.8, maxZoom: 1.15 });
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [graph, centerOn, fitView]);

  useEffect(() => {
    if (!focusRequest || !graph.nodeById.has(focusRequest.id)) return;
    const timer = window.setTimeout(() => {
      centerOn(focusRequest.id, 1.15, 450);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focusRequest, graph, centerOn]);

  if (!graph.objects.length) {
    return <Empty>没有可画的对象。</Empty>;
  }

  const focusSelected = () => {
    if (!selectedId) return;
    centerOn(selectedId, 1.15, 450);
  };

  return (
    <div className="rb-flow h-[clamp(460px,64vh,760px)] overflow-hidden bg-surface min-[1100px]:h-full">
      <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          minZoom={0.12}
          maxZoom={2.4}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          zoomOnDoubleClick={false}
          onInit={(instance) => {
            if (selectedId && graph.nodeById.has(selectedId)) {
              const node = graph.nodeById.get(selectedId)!;
              void instance.setCenter(node.x + NODE_RADIUS, node.y + NODE_RADIUS, {
                zoom: 0.9,
                duration: 0,
              });
            } else {
              void instance.fitView({ padding: 0.16, minZoom: 0.8, maxZoom: 1.15 });
            }
          }}
          onNodeClick={(_, node) => onSelect("objects", node.id)}
          onNodeDoubleClick={(_, node) => {
            centerOn(node.id, 1.15, 450);
          }}
          onPaneClick={onClearSelection}
          proOptions={{ hideAttribution: true }}
          className="bg-surface"
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            ariaLabel="关系图导航小窗：拖动可平移画布"
            nodeColor={(node) => (node.data as BusinessNodeData).color}
            nodeStrokeWidth={0}
            maskStrokeColor="var(--rb-accent)"
            maskStrokeWidth={1.5}
          />
          <Panel position="top-right" className="!m-2 flex gap-1.5">
            <button
              type="button"
              className="rounded-full border border-border bg-surface/95 px-2.5 py-1 text-[11px] text-muted shadow-[var(--rb-shadow)] backdrop-blur transition hover:text-text"
              onClick={() => void fitView({ padding: 0.16, duration: 450, minZoom: 0.8, maxZoom: 1.15 })}
            >
              适应画布
            </button>
            <button
              type="button"
              disabled={!selectedId}
              className="rounded-full border border-border bg-surface/95 px-2.5 py-1 text-[11px] text-muted shadow-[var(--rb-shadow)] backdrop-blur transition hover:text-text disabled:opacity-45"
              onClick={focusSelected}
            >
              聚焦选中
            </button>
          </Panel>
        </ReactFlow>
    </div>
  );
}

function BusinessGraph(props: {
  data: BusinessData;
  typeColors: Map<string, string>;
  selection: BusinessSelection | null;
  query: string;
  focusRequest: GraphFocusRequest | null;
  onSelect: (kind: BusinessCategory, id: string) => void;
  onClearSelection: () => void;
}) {
  return (
    <ReactFlowProvider>
      <BusinessGraphInner {...props} />
    </ReactFlowProvider>
  );
}

export function BusinessPage({ reloadSignal }: { reloadSignal: number }) {
  const request = useApi();
  const [data, setData] = useState<BusinessData | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [lint, setLint] = useState<BusinessLintReport | null>(null);
  const [linting, setLinting] = useState(false);
  const [lintOpen, setLintOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<BusinessCategory>("objects");
  const [graphId, setGraphId] = useState<string>(DEFAULT_GRAPH);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BusinessSelection | null>(null);
  const [focusRequest, setFocusRequest] = useState<GraphFocusRequest | null>(null);

  const load = useCallback(async () => {
    setStatus({ text: "加载中…" });
    try {
      const result = await request<BusinessData>("/v1/business");
      setData(result);
      setStatus({ text: result.exists ? "" : "还没有知识数据。" });
    } catch (e) {
      setData(null);
      setSelectedId(null);
      setDetail(null);
      setStatus({ text: `加载失败：${friendlyError(e)}`, error: true });
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reloadSignal === 0) return;
    void load();
  }, [reloadSignal, load]);

  const runLint = async () => {
    setLinting(true);
    try {
      setLint(await request<BusinessLintReport>("/v1/business/lint"));
    } catch (e) {
      setStatus({ text: `检查失败：${friendlyError(e)}`, error: true });
    } finally {
      setLinting(false);
    }
  };

  const openLint = () => {
    setLintOpen(true);
    void runLint();
  };

  const query = search.trim().toLowerCase();

  const graphIds = useMemo(() => (data ? collectGraphIds(data) : []), [data]);
  const activeGraph = graphId === ALL_GRAPHS || graphIds.includes(graphId) ? graphId : ALL_GRAPHS;
  const graphOptions = useMemo(
    () => [
      { value: ALL_GRAPHS, label: "全部" },
      ...graphIds.map((id) => ({ value: id, label: id })),
    ],
    [graphIds],
  );
  const view = useMemo(
    () => (data ? filterByGraph(data, activeGraph) : null),
    [data, activeGraph],
  );

  const typeColors = useMemo(() => {
    const map = new Map<string, string>();
    view?.types.forEach((type, index) => {
      map.set(type.id, TYPE_COLORS[index % TYPE_COLORS.length]);
    });
    return map;
  }, [view]);

  const relatedIds = useMemo(() => {
    if (!view || !selectedId) return null;
    const ids = new Set<string>([selectedId]);
    for (const edge of view.edges) {
      if (edge.from === selectedId) ids.add(edge.to);
      if (edge.to === selectedId) ids.add(edge.from);
    }
    return ids;
  }, [view, selectedId]);

  const items = useMemo(() => {
    if (!view) return [];
    const base = businessItemsFor(view, category, query);
    if (!relatedIds) return base;
    return base
      .filter((item) => item.kind === "objects" && relatedIds.has(item.id))
      .sort((a, b) => {
        if (a.id === selectedId) return -1;
        if (b.id === selectedId) return 1;
        return a.title.localeCompare(b.title, "zh-Hans-CN");
      });
  }, [view, category, query, relatedIds, selectedId]);

  const selectedObject = useMemo(
    () => (view && selectedId ? view.objects.find((o) => o.id === selectedId) : undefined),
    [view, selectedId],
  );

  const closeDetail = useCallback(() => setDetail(null), []);

  const openDetail = useCallback((kind: BusinessCategory, id: string) => {
    setDetail({ kind, id });
  }, []);

  const selectNode = useCallback((id: string) => {
    setCategory("objects");
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);

  const clearSelection = useCallback(() => setSelectedId(null), []);

  const chooseCategory = (id: BusinessCategory) => {
    setSelectedId(null);
    setCategory(id);
  };

  const chooseGraph = useCallback((id: string) => {
    setGraphId(id);
    setSelectedId(null);
    setDetail(null);
    setFocusRequest(null);
  }, []);

  const focusInGraph = useCallback((id: string) => {
    setDetail(null);
    setFocusRequest({ id, nonce: Date.now() });
  }, []);

  const graphTruncated = !!view && (view.edges_truncated || view.objects.length > 160);

  return (
    <div className="h-full overflow-y-auto px-[clamp(16px,4vw,44px)] pb-[60px] pt-[22px] max-[820px]:px-3.5 max-[820px]:pb-12 max-[820px]:pt-4">
      {status.text ? <StatusText text={status.text} error={status.error} /> : null}

      {!view ? null : !view.exists ? (
        <div className="grid place-items-center rounded-[14px] border border-border bg-surface px-6 py-16 text-center shadow-[var(--rb-shadow)]">
          <p className="m-0 max-w-[380px] text-[13px] leading-relaxed text-muted">
            还没有知识数据。由任务通过 `PUT /v1/business` 写入后再刷新。
          </p>
        </div>
      ) : (
        <>
          <section className="mt-4 overflow-hidden rounded-[14px] border border-border bg-surface shadow-[var(--rb-shadow)]">
            <div className="grid items-stretch min-[1100px]:h-[clamp(520px,70vh,820px)] min-[1100px]:grid-cols-[minmax(0,1fr)_320px]">
              <aside className="order-1 flex max-h-[70vh] min-h-0 flex-col border-b border-border min-[1100px]:order-2 min-[1100px]:max-h-none min-[1100px]:border-b-0 min-[1100px]:border-l">
                <div className="flex-none border-b border-border p-2.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="m-0 text-xs font-semibold">条目</h3>
                    <span className="text-[11px] text-muted tabular-nums">{items.length}</span>
                  </div>
                  {selectedId && selectedObject && (
                    <div className="mt-1.5 flex items-center gap-1.5 rounded-[7px] bg-accent-soft px-1.5 py-1 text-[11px] text-accent">
                      <span className="min-w-0 flex-1 truncate">
                        {`与「${selectedObject.name || selectedObject.id}」相关`}
                      </span>
                      <button
                        type="button"
                        className="flex-none underline-offset-2 hover:underline"
                        onClick={clearSelection}
                      >
                        清除
                      </button>
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {CATEGORIES.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={cx(
                          "rounded-full border px-2 py-0.5 text-[11px] transition",
                          category === c.id
                            ? "border-accent bg-accent-soft text-accent"
                            : "border-border bg-surface text-muted hover:text-text",
                        )}
                        onClick={() => chooseCategory(c.id)}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2">
                    <Input
                      type="search"
                      placeholder="搜索对象 / 关系 / 术语 / 类型"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                  {!items.length ? (
                    <Empty>
                      {query
                        ? `没有匹配「${search.trim()}」的条目。`
                        : selectedId
                          ? "没有找到相关实体。"
                          : "这一分类还没有条目。"}
                    </Empty>
                  ) : (
                    <div className="grid gap-1.5">
                      {items.map((item) => {
                        const active =
                          (item.kind === "objects" && selectedId === item.id) ||
                          (detail?.kind === item.kind && detail?.id === item.id);
                        const objectType =
                          item.kind === "objects"
                            ? view.objects.find((o) => o.id === item.id)?.type
                            : undefined;
                        const dot =
                          (objectType && typeColors.get(objectType)) ||
                          CATEGORY_COLORS[item.kind] ||
                          TYPE_COLORS[0];
                        return (
                          <button
                            key={`${item.kind}:${item.id}`}
                            type="button"
                            className={cx(
                              "w-full rounded-[10px] border px-2.5 py-2 text-left transition",
                              active
                                ? "border-accent bg-accent-soft"
                                : "border-border bg-surface hover:border-accent/45 hover:bg-surface2",
                            )}
                            onClick={() => openDetail(item.kind, item.id)}
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className="h-2 w-2 flex-none rounded-full"
                                style={{ backgroundColor: dot }}
                              />
                              <span className="min-w-0 flex-1 text-[13px] font-semibold wrap-anywhere">
                                {item.title}
                              </span>
                            </div>
                            {item.subtitle && (
                              <div className="mt-0.5 pl-4 text-[11px] text-muted wrap-anywhere">
                                {item.subtitle}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </aside>

              <div className="order-2 flex min-w-0 flex-col min-[1100px]:order-1">
                <header className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h2 className="m-0 text-sm font-semibold">知识图谱</h2>
                    <div className="w-32">
                      <Select
                        value={activeGraph}
                        onValueChange={chooseGraph}
                        options={graphOptions}
                        ariaLabel="切换图谱"
                        className="px-2 py-1 text-[11px]"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted tabular-nums">
                      {`${view.edges.length} 条边${graphTruncated ? " · 已截断" : ""}`}
                    </span>
                    <button
                      type="button"
                      title="检查异常"
                      aria-label="检查异常"
                      className="flex-none rounded-full border border-border bg-surface/95 p-1 text-muted shadow-[var(--rb-shadow)] transition hover:text-text"
                      onClick={openLint}
                    >
                      <BugIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </header>
                <div className="min-h-0 flex-1">
                  <BusinessGraph
                    data={view}
                    typeColors={typeColors}
                    selection={selectedId ? { kind: "objects", id: selectedId } : null}
                    query={query}
                    focusRequest={focusRequest}
                    onSelect={(_kind, id) => selectNode(id)}
                    onClearSelection={clearSelection}
                  />
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      {view?.exists && detail && (
        <Drawer title={`${categoryLabel(detail.kind)}详情`} onClose={closeDetail}>
          <BusinessDetail
            data={view}
            selection={detail}
            onSelect={openDetail}
            onFocus={focusInGraph}
          />
        </Drawer>
      )}

      {lintOpen && (
        <Modal title="检查异常" onClose={() => setLintOpen(false)}>
          {!lint ? (
            <p className="m-0 text-sm text-muted">{linting ? "检查中…" : "还没有检查结果。"}</p>
          ) : (
            <>
              <div className="mb-2.5 flex flex-wrap items-center gap-3">
                <span className="text-xs text-muted">
                  {`error ${lint.summary.error} · warn ${lint.summary.warn} · info ${lint.summary.info}`}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={linting}
                  onClick={() => void runLint()}
                >
                  {linting ? "检查中…" : "重新检查"}
                </Button>
              </div>
              <div className="grid gap-2">
                {lint.findings.length ? (
                  lint.findings.map((f, i) => (
                    <div
                      key={`${f.code}-${i}`}
                      className="flex flex-wrap items-center gap-2 rounded-[12px] border border-border bg-surface px-3 py-2 text-sm"
                    >
                      <Badge
                        variant={
                          f.level === "error" ? "closed" : f.level === "warn" ? "warn" : "info"
                        }
                      >
                        {f.level}
                      </Badge>
                      <span>{f.message}</span>
                      {f.ref ? <span className="font-mono text-xs text-muted">{f.ref}</span> : null}
                    </div>
                  ))
                ) : (
                  <p className="m-0 text-sm text-muted">没有发现异常。</p>
                )}
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
