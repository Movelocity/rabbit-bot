import type { BusinessData } from "./types.ts";

export const ALL_GRAPHS = "all";
export const DEFAULT_GRAPH = "default";

function graphIdOf(item: { graph_id?: string }): string {
  return item.graph_id || DEFAULT_GRAPH;
}

export function collectGraphIds(data: BusinessData): string[] {
  const ids = new Set<string>();
  for (const o of data.objects) ids.add(graphIdOf(o));
  for (const r of data.relations) ids.add(graphIdOf(r));
  for (const e of data.edges) ids.add(graphIdOf(e));
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export function filterByGraph(data: BusinessData, graphId: string): BusinessData {
  if (graphId === ALL_GRAPHS) return data;
  const objects = data.objects.filter((o) => graphIdOf(o) === graphId);
  const objectIds = new Set(objects.map((o) => o.id));
  const relations = data.relations.filter((r) => graphIdOf(r) === graphId);
  const relationIds = new Set(relations.map((r) => r.id));
  const edges = data.edges.filter(
    (e) =>
      relationIds.has(e.relation) &&
      objectIds.has(e.from) &&
      objectIds.has(e.to),
  );
  return {
    ...data,
    objects,
    relations,
    edges,
    terms: data.terms.filter((t) => objectIds.has(t.objectId)),
    edge_total: edges.length,
  };
}
