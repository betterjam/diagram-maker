import { DiagramGroup, DiagramModel, DiagramNode } from './diagram-model';

/**
 * Where a node ended up, and how big its box is.
 */
export interface PlacedNode extends DiagramNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedGroup {
  id: string;
  label: string;
  kind?: 'container' | 'network';
  cidr?: string;
  icon?: string;
  categoryId?: string;
  parentId?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  nodes: PlacedNode[];
  groups: PlacedGroup[];
  /**
   * The box everything laid out fits inside. `x`/`y` are a real corner, not
   * an assumed origin — a hand-placed diagram can sit anywhere, including
   * left of and above zero.
   */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutMode = 'manual' | 'layered' | 'force';

export const NODE_W = 190;
export const NODE_H = 46;
const OVAL_H = 60;
const SIDE = 90;
const CYL_W = 170;
const CYL_H = 76;
const DIAMOND_W = 150;
const DIAMOND_H = 84;
const COL_GAP = 90;
const ROW_GAP = 22;
const GROUP_PAD = 28;
const GROUP_HEAD = 24;

/**
 * A node's box, from its own dimensions or its shape's default.
 * Square and circle keep equal sides whatever was stored.
 */
export function nodeSize(n: DiagramNode): { width: number; height: number } {
  const shape = n.shape ?? 'rect';
  if (shape === 'square' || shape === 'circle') {
    const side = n.width ?? n.height ?? SIDE;
    return { width: side, height: side };
  }
  if (shape === 'cylinder') {
    // Taller than a plain box, since the lid eats into the room for text.
    return { width: n.width ?? CYL_W, height: n.height ?? CYL_H };
  }
  if (shape === 'diamond') {
    // Wider and taller than a box: only the middle band is as wide as the shape.
    return { width: n.width ?? DIAMOND_W, height: n.height ?? DIAMOND_H };
  }
  return {
    width: n.width ?? NODE_W,
    height: n.height ?? (shape === 'oval' ? OVAL_H : NODE_H),
  };
}

/**
 * Places every node.
 *
 * <p><b>manual</b> honours the coordinates already on the model and is what the
 * editor uses. <b>layered</b> ranks nodes into columns by how far they sit from
 * a source and then reduces crossings. <b>force</b> spreads them by repulsion.
 * A node that already has coordinates is never moved by any mode, so a
 * generated diagram can be nudged by hand and keep those edits on reload.</p>
 */
export function layout(model: DiagramModel, mode: LayoutMode = 'manual'): LayoutResult {
  const m = withCategoryShapes(model);
  const placed: PlacedNode[] =
    mode === 'layered' ? layered(m)
    : mode === 'force' ? force(m)
    : manual(m);

  const groups = fitGroups(m, placed);
  return { nodes: placed, groups, ...extent(placed, groups) };
}

/**
 * Fills in the shape a node's family is drawn as, where the node has not
 * asked for one itself.
 *
 * <p>Resolved here rather than written onto a node when it is created, so
 * that a diagram drawn before its family had a shape picks the shape up, and
 * so that a node follows its family if it is moved to another. A node that
 * names its own shape is left alone — including one that names `rect`, which
 * is how a database is told to be an ordinary box after all.</p>
 */
function withCategoryShapes(model: DiagramModel): DiagramModel {
  const byCategory = new Map(model.categories.map((c) => [c.id, c.shape]));
  if (![...byCategory.values()].some(Boolean)) return model;

  return {
    ...model,
    nodes: model.nodes.map((n) =>
      n.shape ? n : { ...n, shape: byCategory.get(n.categoryId) }),
  };
}

/** Straight from the model, with a tidy fallback for anything unplaced. */
function manual(model: DiagramModel): PlacedNode[] {
  let loose = 0;
  return model.nodes.map((n) => {
    const hasPos = n.x != null && n.y != null;
    const pos = hasPos
      ? { x: n.x!, y: n.y! }
      : { x: 60 + (loose % 5) * (NODE_W + COL_GAP), y: 60 + Math.floor(loose++ / 5) * (NODE_H + ROW_GAP) };
    return { ...n, ...pos, ...nodeSize(n) };
  });
}

/**
 * Columns by depth, then a barycenter sweep.
 *
 * Rank is the longest path from a node with no inbound edges, which puts
 * sources on the left and sinks on the right. Ordering each column by the mean
 * row of its neighbours is the classic way to stop edges crossing; a few passes
 * is enough to settle.
 */
function layered(model: DiagramModel): PlacedNode[] {
  const rank = new Map<string, number>();
  const incoming = new Map<string, string[]>();

  for (const n of model.nodes) incoming.set(n.id, []);
  for (const e of model.edges) incoming.get(e.to)?.push(e.from);

  const depth = (id: string, seen = new Set<string>()): number => {
    if (rank.has(id)) return rank.get(id)!;
    if (seen.has(id)) return 0;           // a cycle: stop rather than recurse forever
    seen.add(id);
    const parents = incoming.get(id) ?? [];
    const d = parents.length === 0 ? 0 : Math.max(...parents.map((p) => depth(p, seen) + 1));
    rank.set(id, d);
    return d;
  };
  for (const n of model.nodes) depth(n.id);

  const columns = new Map<number, DiagramNode[]>();
  for (const n of model.nodes) {
    const r = rank.get(n.id) ?? 0;
    (columns.get(r) ?? columns.set(r, []).get(r)!).push(n);
  }

  const rowOf = new Map<string, number>();
  for (const [, list] of columns) list.forEach((n, i) => rowOf.set(n.id, i));

  const neighbours = (id: string) =>
    model.edges.filter((e) => e.from === id || e.to === id).map((e) => (e.from === id ? e.to : e.from));

  for (let pass = 0; pass < 4; pass++) {
    for (const [, list] of columns) {
      list.sort((a, b) => barycenter(a.id) - barycenter(b.id));
      list.forEach((n, i) => rowOf.set(n.id, i));
    }
  }

  function barycenter(id: string): number {
    const rows = neighbours(id).map((n) => rowOf.get(n)).filter((r): r is number => r != null);
    return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : rowOf.get(id) ?? 0;
  }

  const out: PlacedNode[] = [];
  for (const [col, list] of [...columns].sort((a, b) => a[0] - b[0])) {
    list.forEach((n, row) => {
      out.push({
        ...n,
        // An explicit position always wins, so hand edits survive a re-layout.
        x: n.x ?? 60 + col * (NODE_W + COL_GAP),
        y: n.y ?? 60 + row * (NODE_H + ROW_GAP),
        ...nodeSize(n),
      });
    });
  }
  return out;
}

/**
 * Repulsion between every pair, springs along edges, and a pull toward the
 * centroid of a node's own category so families stay together.
 */
function force(model: DiagramModel, iterations = 220): PlacedNode[] {
  const pts = model.nodes.map((n, i) => ({
    node: n,
    x: n.x ?? 400 + Math.cos(i) * (120 + i * 9),
    y: n.y ?? 320 + Math.sin(i) * (120 + i * 9),
    fixed: n.x != null && n.y != null,
  }));
  const byId = new Map(pts.map((p) => [p.node.id, p]));
  const ideal = 260;

  for (let step = 0; step < iterations; step++) {
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const p = pts[a], q = pts[b];
        let dx = q.x - p.x, dy = q.y - p.y;
        let d = Math.hypot(dx, dy) || 0.01;
        const push = (ideal * ideal) / (d * d) * 0.5;
        dx /= d; dy /= d;
        if (!p.fixed) { p.x -= dx * push; p.y -= dy * push; }
        if (!q.fixed) { q.x += dx * push; q.y += dy * push; }
      }
    }

    for (const e of model.edges) {
      const p = byId.get(e.from), q = byId.get(e.to);
      if (!p || !q) continue;
      let dx = q.x - p.x, dy = q.y - p.y;
      const d = Math.hypot(dx, dy) || 0.01;
      const pull = (d - ideal) * 0.015;
      dx /= d; dy /= d;
      if (!p.fixed) { p.x += dx * pull; p.y += dy * pull; }
      if (!q.fixed) { q.x -= dx * pull; q.y -= dy * pull; }
    }

    const centroids = new Map<string, { x: number; y: number; n: number }>();
    for (const p of pts) {
      const c = centroids.get(p.node.categoryId) ?? { x: 0, y: 0, n: 0 };
      c.x += p.x; c.y += p.y; c.n++;
      centroids.set(p.node.categoryId, c);
    }
    for (const p of pts) {
      if (p.fixed) continue;
      const c = centroids.get(p.node.categoryId)!;
      p.x += (c.x / c.n - p.x) * 0.01;
      p.y += (c.y / c.n - p.y) * 0.01;
    }
  }

  // Hard separation so boxes never sit on top of one another.
  for (let pass = 0; pass < 30; pass++) {
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const p = pts[a], q = pts[b];
        const ox = (NODE_W + 30) - Math.abs(q.x - p.x);
        const oy = (NODE_H + 20) - Math.abs(q.y - p.y);
        if (ox > 0 && oy > 0) {
          const sx = Math.sign(q.x - p.x) || 1;
          if (!q.fixed) q.x += sx * ox / 2;
          if (!p.fixed) p.x -= sx * ox / 2;
        }
      }
    }
  }

  const minX = Math.min(...pts.map((p) => p.x)) - 60;
  const minY = Math.min(...pts.map((p) => p.y)) - 60;
  return pts.map((p) => ({
    ...p.node,
    x: p.x - minX,
    y: p.y - minY,
    ...nodeSize(p.node),
  }));
}

/**
 * Grows each container to hold its members, innermost first so a parent
 * ends up enclosing its children rather than cutting through them.
 */
function fitGroups(model: DiagramModel, placed: PlacedNode[]): PlacedGroup[] {
  // A network group encloses the nodes assigned to it as their subnet,
  // alongside anything placed in it as an ordinary container.
  const membersOf = new Map(model.groups.map((g) => [
    g.id,
    new Set(placed.filter((n) => n.groupId === g.id || n.subnetId === g.id).map((n) => n.id)),
  ]));

  /**
   * Whether `outer` wraps `inner`: declared by `parentId`, or implied when
   * every node of `inner` is also in `outer`. The implied case is what makes
   * a container pad around a whole subnet rather than around the bare nodes
   * that happen to sit inside it.
   */
  const wraps = (outer: DiagramGroup, inner: DiagramGroup): boolean => {
    if (outer.id === inner.id) return false;
    if (inner.parentId === outer.id) return true;
    if (outer.parentId === inner.id) return false;

    const a = membersOf.get(inner.id)!, b = membersOf.get(outer.id)!;
    if (!a.size || a.size > b.size) return false;
    for (const nodeId of a) if (!b.has(nodeId)) return false;
    // Same members: the network is the inner one, so a subnet still nests.
    return a.size < b.size || (inner.kind === 'network' && outer.kind !== 'network');
  };

  /**
   * How deep a container sits, counting the whole chain above it rather than
   * only its immediate wrappers.
   *
   * <p>Counting wrappers alone ties a grandchild with its parent — a database
   * inside an application inside a site each have one wrapper — and a tie lets
   * the parent be sized before the box it contains, which leaves the child
   * hanging outside it. Relaxed to a fixed point instead, and bounded by the
   * number of containers so a cyclic declaration still terminates.</p>
   */
  const wrappersOf = new Map(
    model.groups.map((g) => [g.id, model.groups.filter((o) => wraps(o, g))]),
  );
  const depth = new Map(model.groups.map((g) => [g.id, 0]));
  for (let pass = 0; pass < model.groups.length; pass++) {
    let moved = false;
    for (const g of model.groups) {
      const above = wrappersOf.get(g.id)!;
      const want = above.length ? Math.max(...above.map((o) => depth.get(o.id)!)) + 1 : 0;
      if (want !== depth.get(g.id)) {
        depth.set(g.id, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const depthOf = (g: DiagramGroup): number => depth.get(g.id) ?? 0;

  // Fit deepest first, so a parent can size itself around finished children.
  const order = [...model.groups].sort((a, b) => depthOf(b) - depthOf(a));
  const rank = new Map(order.map((g, i) => [g.id, i]));
  const done = new Map<string, PlacedGroup>();

  for (const g of order) {
    const members = placed.filter((n) => n.groupId === g.id || n.subnetId === g.id);
    const childBoxes = [...done.values()].filter((c) => {
      const child = model.groups.find((x) => x.id === c.id);
      return !!child && wraps(g, child);
    });

    const boxes = [
      ...members.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height })),
      ...childBoxes.map((c) => ({ x: c.x, y: c.y, w: c.width, h: c.height })),
    ];

    // A hand-sized container keeps its geometry even when empty.
    if (g.width != null && g.height != null && g.x != null && g.y != null) {
      done.set(g.id, { ...g, x: g.x, y: g.y, width: g.width, height: g.height } as PlacedGroup);
      continue;
    }
    if (boxes.length === 0) continue;

    const x = Math.min(...boxes.map((b) => b.x)) - GROUP_PAD;
    const y = Math.min(...boxes.map((b) => b.y)) - GROUP_PAD - GROUP_HEAD;
    const right = Math.max(...boxes.map((b) => b.x + b.w)) + GROUP_PAD;
    const bottom = Math.max(...boxes.map((b) => b.y + b.h)) + GROUP_PAD;

    done.set(g.id, {
      id: g.id, label: g.label, kind: g.kind, cidr: g.cidr, icon: g.icon,
      categoryId: g.categoryId, parentId: g.parentId,
      x, y, width: right - x, height: bottom - y,
    });
  }

  // Hand them back outermost first, which is painting order: a nested box
  // belongs on top of the one holding it, and — since a container's fill is
  // faintly painted rather than hollow — that is also what lets a pointer
  // reach an inner container instead of stopping at its parent.
  return [...done.values()].sort((a, b) => rank.get(b.id)! - rank.get(a.id)!);
}

/**
 * The box holding every laid-out thing.
 *
 * <p>Containers count as well as boxes: one reaches a good way past the
 * boxes it holds, by its padding and its label band, and a container given
 * geometry by hand may sit anywhere at all. Corners are taken from what is
 * actually there rather than assumed to be the origin, so a diagram drawn
 * up and to the left of zero frames as readily as one drawn below it.</p>
 */
function extent(
  placed: PlacedNode[],
  groups: PlacedGroup[],
): { x: number; y: number; width: number; height: number } {
  const boxes = [
    ...placed.map((n) => ({ x: n.x, y: n.y, r: n.x + n.width, b: n.y + n.height })),
    ...groups.map((g) => ({ x: g.x, y: g.y, r: g.x + g.width, b: g.y + g.height })),
  ];
  if (boxes.length === 0) return { x: 0, y: 0, width: 1200, height: 700 };

  const x = Math.min(...boxes.map((v) => v.x));
  const y = Math.min(...boxes.map((v) => v.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((v) => v.r)) - x,
    height: Math.max(...boxes.map((v) => v.b)) - y,
  };
}
