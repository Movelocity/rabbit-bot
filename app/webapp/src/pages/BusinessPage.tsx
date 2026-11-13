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
  type MiniMapNodeProps,
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
import {
  BUSINESS_NODE_SIZE,
  layoutBusinessGraph,
  type BusinessLayoutNode,
} from "../lib/business-layout.ts";
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

function useIsWide(px: number): boolean {
  const [wide, setWide] = useState(
    () => typeof window === "undefined" || window.matchMedia(`(min-width:${px}px)`).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(`(min-width:${px}px)`);
    const onChange = () => setWide(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [px]);
  return wide;
}

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

interface GraphNode extends BusinessLayoutNode {
  name: string;
  search: string;
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

const NODE_SIZE = BUSINESS_NODE_SIZE;
const NODE_RADIUS = NODE_SIZE / 2;
const ARROW_GAP = 12;
const EDGE_BEND_STEP = 42;

interface BusinessEdgeData extends Record<string, unknown> {
  bend: number;
  selfLoop: boolean;
}

type BusinessFlowEdge = Edge<BusinessEdgeData, "business">;

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

function MiniMapCircleNode({
  x,
  y,
  width,
  height,
  color,
  strokeColor,
  strokeWidth,
  className,
}: MiniMapNodeProps) {
  const radius = Math.min(width, height) / 2;
  return (
    <circle
      cx={x + width / 2}
      cy={y + height / 2}
      r={radius}
      fill={color}
      stroke={strokeColor}
      strokeWidth={strokeWidth}
      className={className}
    />
  );
}

function EdgeLabel({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <EdgeLabelRenderer>
      <div
        style={{
          position: "absolute",
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
          pointerEvents: "none",
        }}
        className="rounded-[4px] border border-border/60 bg-surface/90 px-1 py-px text-[11px] leading-tight text-muted shadow-sm"
      >
        {children}
      </div>
    </EdgeLabelRenderer>
  );
}

function BusinessEdgeView({
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  label,
  markerEnd,
  data,
}: EdgeProps<BusinessFlowEdge>) {
  if (data?.selfLoop) {
    const startX = sourceX + NODE_RADIUS * 0.55;
    const startY = sourceY - NODE_RADIUS * 0.66;
    const endX = sourceX - NODE_RADIUS * 0.55;
    const endY = sourceY - NODE_RADIUS * 0.66;
    return (
      <>
        <path
          d={`M ${startX},${startY} C ${sourceX + NODE_RADIUS * 1.8},${sourceY - NODE_RADIUS * 2.4} ${sourceX - NODE_RADIUS * 1.8},${sourceY - NODE_RADIUS * 2.4} ${endX},${endY}`}
          fill="none"
          style={style}
          markerEnd={markerEnd}
        />
        {label && (
          <EdgeLabel x={sourceX} y={sourceY - NODE_RADIUS * 1.9}>
            {label}
          </EdgeLabel>
        )}
      </>
    );
  }

  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return null;

  const baseAngle = Math.atan2(dy, dx);
  const portOffset = Math.max(-0.85, Math.min(0.85, (data?.bend ?? 0) / 150));
  const maxAnchor = Math.max(0, (distance - 6) / 2);
  const sourceRadius = Math.min(NODE_RADIUS, maxAnchor);
  const targetRadius = Math.min(NODE_RADIUS + ARROW_GAP, maxAnchor);
  const sourceAngle = baseAngle + portOffset;
  const targetAngle = baseAngle + Math.PI - portOffset;
  const startX = sourceX + Math.cos(sourceAngle) * sourceRadius;
  const startY = sourceY + Math.sin(sourceAngle) * sourceRadius;
  const endX = targetX + Math.cos(targetAngle) * targetRadius;
  const endY = targetY + Math.sin(targetAngle) * targetRadius;

  const ux = dx / distance;
  const uy = dy / distance;
  const bend = data?.bend ?? 0;
  const midX = (startX + endX) / 2;
  const midY = (startY + endY) / 2;
  const controlX = midX - uy * bend;
  const controlY = midY + ux * bend;
  const labelX = (startX + 2 * controlX + endX) / 4;
  const labelY = (startY + 2 * controlY + endY) / 4;

  return (
    <>
      <path
        d={`M ${startX},${startY} Q ${controlX},${controlY} ${endX},${endY}`}
        fill="none"
        style={style}
        markerEnd={markerEnd}
      />
      {label && (
        <EdgeLabel x={labelX} y={labelY}>
          {label}
        </EdgeLabel>
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
    layoutBusinessGraph(nodes, edges);
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

  const edges = useMemo<BusinessFlowEdge[]>(() => {
    const pairKey = (from: string, to: string) => (from <= to ? `${from}\u0000${to}` : `${to}\u0000${from}`);
    const pairTotals = new Map<string, number>();
    for (const edge of graph.edges) {
      const key = pairKey(edge.from, edge.to);
      pairTotals.set(key, (pairTotals.get(key) ?? 0) + 1);
    }
    const pairSeen = new Map<string, number>();

    return graph.edges.map((edge, index): BusinessFlowEdge => {
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
      const key = pairKey(edge.from, edge.to);
      const ordinal = pairSeen.get(key) ?? 0;
      pairSeen.set(key, ordinal + 1);
      const total = pairTotals.get(key) ?? 1;
      const reverse = edge.from > edge.to;
      const bend =
        (ordinal - (total - 1) / 2) * EDGE_BEND_STEP * (reverse ? -1 : 1);

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
        data: {
          bend,
          selfLoop: edge.from === edge.to,
        },
      };
    });
  }, [graph, selectedId, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (selectedId && graph.nodeById.has(selectedId)) {
        centerOn(selectedId, 0.9, 0);
      } else {
        void fitView({ padding: 0.16, duration: 0, minZoom: 0.12, maxZoom: 1.15 });
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
              void instance.fitView({ padding: 0.16, minZoom: 0.12, maxZoom: 1.15 });
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
            nodeComponent={MiniMapCircleNode}
            nodeStrokeWidth={0}
            maskStrokeColor="var(--rb-accent)"
            maskStrokeWidth={1.5}
          />
          <Panel position="top-right" className="!m-2 flex gap-1.5">
            <button
              type="button"
              className="rounded-full border border-border bg-surface/95 px-2.5 py-1 text-[11px] text-muted shadow-[var(--rb-shadow)] backdrop-blur transition hover:text-text"
              onClick={() => void fitView({ padding: 0.16, duration: 450, minZoom: 0.12, maxZoom: 1.15 })}
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
    setDetail(null);
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);

  const clearSelection = useCallback(() => setSelectedId(null), []);

  const chooseCategory = (id: BusinessCategory) => {
    setSelectedId(null);
    setDetail(null);
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
  const isWide = useIsWide(1100);
  const effectiveSelection: BusinessSelection | null = detail ?? (selectedId ? { kind: "objects", id: selectedId } : null);
  const categoryCounts: Record<BusinessCategory, number> = {
    objects: view?.objects.length ?? 0,
    relations: view?.relations.length ?? 0,
    actions: view?.actions.length ?? 0,
    terms: view?.terms.length ?? 0,
    types: view?.types.length ?? 0,
  };
  const lintCount = lint ? lint.summary.error + lint.summary.warn : null;
  const legend = view ? [...typeColors.entries()].slice(0, 8) : [];
  const closeEffective = () => {
    closeDetail();
    clearSelection();
  };

  if (!view) {
    return (
      <div className="grid h-full place-items-center p-6">
        <StatusText text={status.text || "加载中…"} error={status.error} />
      </div>
    );
  }

  if (!view.exists) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="grid max-w-[420px] place-items-center rounded-[14px] border border-border bg-surface px-6 py-12 text-center shadow-[var(--rb-shadow)]">
          <p className="m-0 text-[13px] leading-relaxed text-muted">
            还没有知识数据。由任务通过 `PUT /v1/business` 写入后再刷新。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[250px_minmax(0,1fr)_330px] max-[1100px]:grid-cols-[230px_minmax(0,1fr)] max-[820px]:grid-cols-1 max-[820px]:grid-rows-[minmax(0,45vh)_minmax(360px,1fr)]">
      <aside className="flex min-h-0 flex-col border-r border-border bg-surface max-[820px]:border-b max-[820px]:border-r-0">
        <div className="flex-none px-3.5 pb-1.5 pt-3.5">
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
            Business Map
          </div>
          <div className="rb-display mt-0.5 text-[17px] font-bold">知识</div>
          <div className="mt-1 text-[11.5px] text-muted">
            只读{lintCount !== null ? ` · lint ${lintCount} 项` : ""}
          </div>
        </div>
        <div className="flex flex-none flex-wrap gap-1 px-3 pb-2">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className={cx(
                "rounded-full border px-2 py-0.5 text-[11px] transition",
                category === c.id
                  ? "border-accent/40 bg-accent-soft font-bold text-accent-ink"
                  : "border-border bg-surface text-muted hover:text-text",
              )}
              onClick={() => chooseCategory(c.id)}
            >
              {c.label} {categoryCounts[c.id]}
            </button>
          ))}
        </div>
        <div className="flex-none px-3 pb-2">
          <Input
            type="search"
            placeholder="搜索…"
            className="py-1.5 text-[12px]"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {status.text ? (
          <div className="px-3">
            <StatusText text={status.text} error={status.error} />
          </div>
        ) : null}
        {selectedId && selectedObject ? (
          <div className="mx-2 mb-1.5 flex flex-none items-center gap-1.5 rounded-[7px] bg-accent-soft px-2 py-1 text-[11px] text-accent-ink">
            <span className="min-w-0 flex-1 truncate">
              与「{selectedObject.name || selectedObject.id}」相关
            </span>
            <button type="button" className="flex-none hover:underline" onClick={clearSelection}>
              清除
            </button>
          </div>
        ) : null}
        <div className="rb-thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3.5">
          {!items.length ? (
            <Empty>
              {query
                ? `没有匹配「${search.trim()}」的条目。`
                : selectedId
                  ? "没有找到相关实体。"
                  : "这一分类还没有条目。"}
            </Empty>
          ) : (
            items.map((item) => {
              const active =
                (item.kind === "objects" && selectedId === item.id) ||
                (detail?.kind === item.kind && detail?.id === item.id);
              return (
                <button
                  key={`${item.kind}:${item.id}`}
                  type="button"
                  className={cx(
                    "mb-0.5 block w-full rounded-[8px] px-2 py-1.5 text-left transition",
                    active ? "bg-accent-soft" : "hover:bg-surface2",
                  )}
                  onClick={() => openDetail(item.kind, item.id)}
                >
                  <span className="block truncate text-[12px] font-semibold">{item.title}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-faint">
                    {item.subtitle}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <section className="relative flex min-h-0 min-w-0 flex-col bg-bg">
        <header className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3.5 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-[13px] font-semibold">知识图谱</h2>
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
            <span className="text-[11px] tabular-nums text-muted">
              {view.edges.length} 条边{graphTruncated ? " · 已截断" : ""}
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
        {legend.length ? (
          <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[calc(100%-24px)] flex-wrap gap-2 rounded-[8px] border border-border bg-surface px-2 py-1 text-[9.5px] text-muted">
            {legend.map(([id, color]) => (
              <span key={id} className="inline-flex items-center gap-1">
                <i
                  className="inline-block size-[7px] rounded-[2px]"
                  style={{ backgroundColor: color }}
                />
                {businessTypeName(view, id)}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      {isWide ? (
        <aside className="rb-thin-scroll min-h-0 overflow-y-auto border-l border-border bg-surface p-3.5">
          {effectiveSelection ? (
            <BusinessDetail
              data={view}
              selection={effectiveSelection}
              onSelect={openDetail}
              onFocus={focusInGraph}
            />
          ) : (
            <p className="mx-auto my-8 max-w-[320px] text-center text-[13px] text-muted">
              选一个条目看详情，或切到关系图点节点。
            </p>
          )}
        </aside>
      ) : null}

      {!isWide && effectiveSelection ? (
        <Drawer title={`${categoryLabel(effectiveSelection.kind)}详情`} onClose={closeEffective}>
          <BusinessDetail
            data={view}
            selection={effectiveSelection}
            onSelect={openDetail}
            onFocus={focusInGraph}
          />
        </Drawer>
      ) : null}

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
