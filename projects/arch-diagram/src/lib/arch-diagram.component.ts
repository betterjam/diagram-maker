import {
  Component, ElementRef, EventEmitter, Input, OnDestroy, Output, ViewChild,
  computed, signal, ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  DiagramModel, DiagramNode, DiagramFlow, FlowStep, EdgeSpeed, EDGE_SPEED_MS,
  FLOW_BEAT_MS, FLOW_BEAT_STEP_MS,
  DEFAULT_TYPE_ICONS, categoryColor, nodeIcon, vectorIconPath,
} from './diagram-model';
import { LayoutMode, PlacedGroup, PlacedNode, layout, NODE_W, NODE_H } from './diagram-layout';

const hexA = (hex: string, alpha: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Matches the `.arch-host` background, and so the backdrop a capture paints. */
const CANVAS_BG = '#0b1220';

/** A container with no category of its own, and links anchored to one. */
const GROUP_NEUTRAL = '#41506b';

/** Breathing room left around the diagram when framing or exporting it. */
const FRAME_PAD = 40;

/** How big an icon draws, typed or drawn, so the two are interchangeable. */
const ICON_PX = 16;

/** The same, for the smaller icon in a container's label band. */
const GROUP_ICON_PX = 14;

/** Kept in step with `.arch-edge-label`; a chip is only as good as its width. */
const EDGE_LABEL_FONT = '600 10px ui-sans-serif, system-ui, sans-serif';
const EDGE_LABEL_TRACKING = 0.6;   // letter-spacing: .06em at 10px

let measurer: CanvasRenderingContext2D | null | undefined;

/**
 * How wide an edge label will draw.
 *
 * <p>Measured rather than guessed from a character count: a chip a few pixels
 * too narrow leaves the connector showing through the ends of the text, and
 * one too wide reads as a misplaced box. A canvas measures the same font the
 * SVG will use, with the tracking added back on since canvas ignores it.</p>
 */
const measure = (text: string, font: string): number => {
  if (measurer === undefined) {
    measurer = typeof document === 'undefined'
      ? null
      : document.createElement('canvas').getContext('2d');
  }
  if (!measurer) return text.length * 6;
  measurer.font = font;
  return measurer.measureText(text).width;
};

const labelWidth = (text: string): number =>
  measure(text, EDGE_LABEL_FONT) + EDGE_LABEL_TRACKING * Math.max(0, text.length - 1);

/**
 * The dash pattern repeats every 14 user units, so shifting a line by that
 * much lands it back on itself. That is what makes a capture loop closeable:
 * hold each link for a whole number of pattern lengths and the last frame
 * hands back to the first. Frames are 50ms apart, so a loop of N milliseconds
 * is N/50 of them.
 */
const DASH_PERIOD = 14;
const CAPTURE_DELAY_MS = 50;

/**
 * A long loop is captured at half the frame rate, because a GIF of a nine-hop
 * flow at 20fps is hundreds of frames and tens of megabytes for no more
 * information. Both delays divide every beat and every dash period, so the
 * last frame still hands back to the first.
 */
const SLOW_CAPTURE_DELAY_MS = 100;
const LONG_LOOP_MS = 3000;

/** How big one frame may get when nothing else has already limited it. */
const FRAME_PIXEL_CAP = 2.2e6;

/**
 * Roughly what one frame of flat vector art costs a GIF, in bytes.
 *
 * <p>Not a rate per pixel: measured across these diagrams, a frame's cost
 * grows with about the 0.6 power of its area, because drawing the same picture
 * larger adds pixels that neighbour pixels the encoder has already seen. A
 * flat rate fitted at one size is half again too high at three times the area.
 * Within one diagram this lands inside a few per cent; between diagrams it can
 * be a quarter out either way, since a denser picture compresses worse — hence
 * "about" wherever it is shown.</p>
 */
const gifFrameBytes = (width: number, height: number): number =>
  11.5 * Math.pow(width * height, 0.61);

/**
 * How fast the dashes march on the hop a flow is currently travelling.
 * A whole divisor of {@link FLOW_BEAT_MS}, so the moving line lands back on
 * itself at every beat and the loop closes. Every other link holds still,
 * which keeps the eye on the one thing that is moving.
 */
const FLOW_DASH_MS = 300;

/** The caption band above a playing flow. */
const BANNER_H = 64;
const BANNER_GAP = 22;
const BANNER_TEXT_X = 62;
const BANNER_MIN_W = 300;
const BANNER_STEP_FONT = '600 12.5px ui-sans-serif, system-ui, sans-serif';
const BANNER_DETAIL_FONT = '400 9.5px ui-monospace, monospace';

const centre = (b: { x: number; y: number; width: number; height: number }) =>
  ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Where a point sits along a polyline, as a fraction of its whole length. */
const pointAlong = (pts: { x: number; y: number }[], t: number): { x: number; y: number } => {
  if (pts.length < 2) return pts[0] ?? { x: 0, y: 0 };
  const spans = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  const total = spans.reduce((a, b) => a + b, 0);
  if (total === 0) return pts[0];

  let want = Math.min(Math.max(t, 0), 1) * total;
  for (let i = 0; i < spans.length; i++) {
    if (want <= spans[i] || i === spans.length - 1) {
      const f = spans[i] === 0 ? 0 : want / spans[i];
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * f,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * f,
      };
    }
    want -= spans[i];
  }
  return pts[pts.length - 1];
};

/** The roundest an elbow gets; tight turns get less, see {@link corner}. */
const CORNER_R = 8;

/**
 * How far out of line two boxes can sit and still be joined by a straight
 * connector. A jog of a few pixels reads as a mistake rather than as
 * meaning something, so anything under this is drawn level.
 */
const SNAP_UNITS = 22;

/**
 * How far to round an elbow, given the offsets it has to turn through.
 *
 * <p>A fixed radius kinks: when two boxes are nearly but not quite aligned,
 * two 8px quarter-arcs need 16px of room in an offset only a few pixels wide,
 * so they overshoot each other and the line doubles back on itself. Half the
 * smaller offset is the most either arc can use; at zero the corner is simply
 * square, which is what a right-angle turn should look like anyway.</p>
 */
const corner = (dx: number, dy: number): number =>
  Math.max(0, Math.min(CORNER_R, Math.abs(dx) / 2, Math.abs(dy) / 2));

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not rasterise the diagram.'));
    image.src = url;
  });


/** How much of a picture a capture is allowed to spend. */
export interface CaptureOptions {
  /** Widest the picture may be drawn, in device pixels. */
  maxWidth?: number;
  /** Most device pixels per diagram unit, so a small diagram is not blown up. */
  maxScale?: number;
  /** Pixels across the whole loop. A long journey is drawn smaller for it. */
  pixelBudget?: number;
  /** Pixels in any single frame, whatever the budget would otherwise allow. */
  maxFramePixels?: number;
}

/** What a capture would produce, worked out before producing it. */
export interface CapturePlan {
  frames: number;
  width: number;
  height: number;
  delayMs: number;
  loopMs: number;
  /** A rough file size in bytes, from how flat art tends to compress. */
  bytes: number;
}

/**
 * The whole of a flow at one instant.
 *
 * <p>Worked out from a time rather than from whatever the running animation
 * happens to be doing, which is what lets the live canvas and a frame-by-frame
 * capture agree exactly.</p>
 */
export interface FlowFrame {
  /** The hop travelling now, or the last one while the flow rests. */
  index: number;
  /**
   * Null during the pause at the end. `edgeId` is absent when the hop steps
   * into a container rather than travelling a link.
   */
  active: { edgeId?: string; from: string; to: string; reverse: boolean; t: number } | null;
  caption: { index: string; step: string; detail: string };
  /** Boxes the journey has reached. */
  nodes: Set<string>;
  /** Links it has finished travelling. */
  edges: Set<string>;
  /** How far through the loop, from 0 to 1. */
  progress: number;
}

/**
 * Draws a diagram model.
 *
 * <p>Rendered as an Angular template rather than by building SVG nodes in
 * code. It costs a little performance on very large graphs and buys the
 * ability to bind events straight to shapes — which is what makes the same
 * component usable as a read-only picture in one app and as an editable
 * canvas in another. Interaction is opt-in through <code>editable</code>.</p>
 */
@Component({
  selector: 'arch-diagram',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="arch-host" #host>
      <svg #svg class="arch-svg"
           [attr.viewBox]="viewBox()"
           (pointerdown)="onCanvasDown($event)"
           (pointermove)="onMove($event)"
           (pointerup)="onUp()"
           (pointerleave)="onUp()"
           (wheel)="onWheel($event)">

        <!-- containers first so everything else sits on top -->
        @for (g of view().groups; track g.id) {
          <g class="arch-group" [class.selected]="g.id === selectedGroupId"
             [attr.data-id]="g.id" [class.lit]="litNode(g.id)"
             (pointerdown)="onGroupDown($event, g.id)">
            <rect class="arch-group-box"
                  [attr.x]="g.x" [attr.y]="g.y" [attr.width]="g.width" [attr.height]="g.height"
                  rx="14"
                  [attr.stroke]="groupColor(g.categoryId)"
                  [attr.fill]="groupFill(g.categoryId)"
                  [attr.stroke-dasharray]="g.kind === 'network' ? '2 4' : '6 4'"
                  stroke-width="1.2" />
            @if (groupIcon(g); as gi) {
              @if (vectorFor(gi); as d) {
                <g [attr.transform]="groupIconTransform(g)">
                  <path [attr.d]="d" class="arch-vico" [attr.stroke]="groupColor(g.categoryId)" />
                </g>
              } @else {
                <text [attr.x]="g.x + 14" [attr.y]="g.y + 21"
                      [attr.fill]="groupColor(g.categoryId)" class="arch-group-ico">{{ gi }}</text>
              }
            }
            <text [attr.x]="g.x + (groupIcon(g) ? 32 : 14)" [attr.y]="g.y + 20"
                  [attr.fill]="groupColor(g.categoryId)"
                  class="arch-group-label">{{ g.label }}{{ g.cidr ? ' · ' + g.cidr : '' }}</text>
            <!-- the label band is the grab handle, so the interior still pans -->
            <rect class="arch-group-head" [class.grab]="editable"
                  [attr.x]="g.x" [attr.y]="g.y" [attr.width]="g.width" [attr.height]="28"
                  fill="transparent"
                  (pointerdown)="onGroupHeadDown($event, g)" />
          </g>
        }

        @for (e of edges(); track e.id) {
          <g class="arch-edge" [class.dim]="dimmedEdge(e)" [class.lit]="litEdge(e)"
             [class.selected]="e.id === selectedEdgeId" [class.bidir]="!!e.tail"
             [attr.data-id]="e.id" [attr.data-speed]="e.speed">
            <path class="arch-line" [attr.d]="e.path" fill="none"
                  [attr.stroke]="e.color"
                  [attr.stroke-dasharray]="e.dash"
                  stroke-width="1.8" stroke-linecap="round" />
            <path [attr.d]="e.arrow" [attr.fill]="e.color" />
            @if (e.tail) {
              <path [attr.d]="e.tail" [attr.fill]="e.color" />
            }
            @if (e.label) {
              <!-- a chip, so the connector does not run through the words -->
              <!-- the band clears the ascenders above the baseline at e.ly,
                   and sits centred on the capitals rather than on the box -->
              <rect class="arch-edge-chip"
                    [attr.x]="e.lx - e.labelW / 2 - 5" [attr.y]="e.ly - 10.5"
                    [attr.width]="e.labelW + 10" height="14" rx="3"
                    (pointerdown)="onEdgeDown($event, e.id)" />
              <text [attr.x]="e.lx" [attr.y]="e.ly" [attr.fill]="e.color" class="arch-edge-label">{{ e.label }}</text>
            }
            <!-- a thin line is a poor click target; this fat invisible twin isn't -->
            <path class="arch-hit" [attr.d]="e.path" fill="none" stroke="transparent"
                  stroke-width="14" (pointerdown)="onEdgeDown($event, e.id)" />
          </g>
        }

        @for (n of view().nodes; track n.id) {
          <g class="arch-node"
             [attr.data-id]="n.id"
             [class.selected]="n.id === selectedId"
             [class.dim]="dimmedNode(n.id)"
             [class.lit]="litNode(n.id)"
             [attr.transform]="'translate(' + n.x + ',' + n.y + ')'"
             (pointerdown)="onNodeDown($event, n)"
             (pointerenter)="hovered.set(n.id)"
             (pointerleave)="hovered.set(null)">
            @if (n.shape === 'cylinder') {
              <path class="arch-shape" [attr.d]="cylinderPath(n)"
                    [attr.stroke]="color(n.categoryId)"
                    [attr.fill]="nodeFill(n.categoryId)"
                    stroke-width="1.3" />
              <path class="arch-lid" [attr.d]="cylinderLid(n)"
                    [attr.stroke]="color(n.categoryId)" />
            } @else if (n.shape === 'diamond') {
              <path class="arch-shape" [attr.d]="diamondPath(n)"
                    [attr.stroke]="color(n.categoryId)"
                    [attr.fill]="nodeFill(n.categoryId)"
                    stroke-width="1.3" />
            } @else if (isRound(n)) {
              <ellipse class="arch-shape"
                       [attr.cx]="n.width / 2" [attr.cy]="n.height / 2"
                       [attr.rx]="n.width / 2" [attr.ry]="n.height / 2"
                       [attr.stroke]="color(n.categoryId)"
                       [attr.fill]="nodeFill(n.categoryId)"
                       stroke-width="1.3" />
            } @else {
              <rect class="arch-shape" [attr.width]="n.width" [attr.height]="n.height" rx="8"
                    [attr.stroke]="color(n.categoryId)"
                    [attr.fill]="nodeFill(n.categoryId)"
                    stroke-width="1.3" />
            }
            @if (n.shape === 'diamond') {
              <!-- a decision is its question: no icon, both lines in the wide middle -->
              <text [attr.x]="n.width / 2" [attr.y]="n.height / 2 + (n.sublabel ? -1 : 4)" class="arch-title mid">{{ n.label }}</text>
              @if (n.sublabel) {
                <text [attr.x]="n.width / 2" [attr.y]="n.height / 2 + 12" class="arch-sub mid">{{ n.sublabel }}</text>
              }
            } @else if (isCentered(n)) {
              @if (vector(n); as d) {
                <g [attr.transform]="iconTransform(n)">
                  <path [attr.d]="d" class="arch-vico" [attr.stroke]="color(n.categoryId)" />
                </g>
              } @else {
                <text [attr.x]="n.width / 2" [attr.y]="iconY(n)" class="arch-icon mid">{{ icon(n) }}</text>
              }
              <text [attr.x]="n.width / 2" [attr.y]="titleY(n)" class="arch-title mid">{{ n.label }}</text>
              @if (n.sublabel) {
                <text [attr.x]="n.width / 2" [attr.y]="subY(n)" class="arch-sub mid">{{ n.sublabel }}</text>
              }
            } @else {
              @if (showIcon(n)) {
                @if (vector(n); as d) {
                  <g [attr.transform]="iconTransform(n)">
                    <path [attr.d]="d" class="arch-vico" [attr.stroke]="color(n.categoryId)" />
                  </g>
                } @else {
                  <text [attr.x]="padX(n)" [attr.y]="iconY(n)" class="arch-icon">{{ icon(n) }}</text>
                }
              }
              <text [attr.x]="titleX(n)" [attr.y]="titleY(n)" class="arch-title">{{ n.label }}</text>
              @if (n.sublabel) {
                <text [attr.x]="titleX(n)" [attr.y]="subY(n)" class="arch-sub">{{ n.sublabel }}</text>
              }
            }
            @if (editable && n.id === selectedId) {
              <rect class="arch-resize" [attr.x]="n.width - 6" [attr.y]="n.height - 6"
                    width="12" height="12" rx="2"
                    (pointerdown)="onResizeDown($event, n)" />
            }
          </g>
        }

        <!-- the flow caption and its travelling dot, above the diagram -->
        @if (banner(); as b) {
          <g class="arch-flow" pointer-events="none">
            <rect class="arch-flow-band" [attr.x]="b.x" [attr.y]="b.y"
                  [attr.width]="b.w" [attr.height]="b.h" rx="10" />
            <text class="arch-flow-name" [attr.x]="b.x + 14" [attr.y]="b.y + 18">{{ b.name }}</text>
            <text class="arch-flow-index" [attr.x]="b.x + 14" [attr.y]="b.y + 38">{{ b.index }}</text>
            <text class="arch-flow-step" [attr.x]="b.x + 62" [attr.y]="b.y + 38">{{ b.step }}</text>
            <text class="arch-flow-detail" [attr.x]="b.x + 62" [attr.y]="b.y + 53">{{ b.detail }}</text>
            <rect class="arch-flow-track" [attr.x]="b.x" [attr.y]="b.y + b.h - 3"
                  [attr.width]="b.w" height="3" />
            <rect class="arch-flow-fill" [attr.x]="b.x" [attr.y]="b.y + b.h - 3"
                  [attr.width]="b.w * b.progress" height="3" [attr.fill]="b.color" />
            <g class="arch-token" [attr.display]="b.token ? null : 'none'"
               [attr.transform]="'translate(' + (b.token?.x ?? 0) + ',' + (b.token?.y ?? 0) + ')'">
              <circle class="arch-token-halo" r="13" [attr.fill]="b.color" />
              <circle class="arch-token-ring" r="7.5" [attr.stroke]="b.color" />
              <circle class="arch-token-dot" r="4.5" [attr.fill]="b.color" />
            </g>
          </g>
        }

        <!-- last, so it floats above everything -->
        @if (tip(); as t) {
          <g class="arch-tip" pointer-events="none">
            <rect [attr.x]="t.x" [attr.y]="t.y" [attr.width]="t.w" [attr.height]="t.h" rx="8" />
            <text [attr.x]="t.x + 12" [attr.y]="t.y + 17" class="tip-title">{{ t.label }}</text>
            @if (t.sub) {
              <text [attr.x]="t.x + 12" [attr.y]="t.y + 31" class="tip-sub">{{ t.sub }}</text>
            }
            <line [attr.x1]="t.x" [attr.x2]="t.x + t.w" [attr.y1]="t.y + t.headH" [attr.y2]="t.y + t.headH" />
            @for (r of t.rows; track $index) {
              @if (r.line != null) {
                <text [attr.x]="t.x + 12" [attr.y]="t.y + t.headH + 14 + $index * 15" class="tip-line">{{ r.line }}</text>
              } @else {
                <text [attr.x]="t.x + 12" [attr.y]="t.y + t.headH + 14 + $index * 15" class="tip-key">{{ r.k }}</text>
                <text [attr.x]="t.x + t.w - 12" [attr.y]="t.y + t.headH + 14 + $index * 15" class="tip-val">{{ r.v }}</text>
              }
            }
          </g>
        }
      </svg>
    </div>
  `,
  styles: [`
    .arch-host { width: 100%; height: 100%; overflow: hidden; background: #0b1220; }
    .arch-svg { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
    .arch-group-label { font: 600 10px ui-sans-serif, system-ui; letter-spacing: .08em; text-transform: uppercase; }
    .arch-group-ico { font-size: 12px; }
    .arch-group-head.grab { cursor: move; }
    .arch-group.selected .arch-group-box { stroke-width: 2.4; }
    .arch-group.lit .arch-group-box { stroke-width: 2.2; stroke-dasharray: none; }
    .arch-icon { font-size: 14px; }
    .arch-vico { fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .arch-lid { fill: none; stroke-width: 1.3; }
    .arch-title { fill: #e6edf7; font: 600 11px ui-sans-serif, system-ui; }
    .arch-sub { fill: #93a3bd; font: 400 9px ui-monospace, monospace; }
    .mid { text-anchor: middle; }
    .arch-edge-label { font: 600 10px ui-sans-serif, system-ui; letter-spacing: .06em;
                       text-anchor: middle; pointer-events: none; }
    .arch-edge-chip { fill: #0b1220; cursor: pointer; }
    .arch-node { cursor: pointer; }
    .arch-node.selected .arch-shape { stroke-width: 2.2; }
    .arch-node.lit .arch-shape { stroke-width: 2.1; }
    .arch-edge.lit .arch-line { stroke-width: 2.4; }
    .arch-edge.selected .arch-line { stroke-width: 2.8; }
    .arch-hit { pointer-events: stroke; cursor: pointer; }
    /* Dashes march toward the arrowhead; solid edges have no dashes to move.
       A two-way link washes back and forth instead. Durations must stay in
       step with EDGE_SPEED_MS, which is what lets a GIF close seamlessly. */
    .arch-line[stroke-dasharray] { animation: arch-flow 1.2s linear infinite; }
    .arch-edge.bidir .arch-line[stroke-dasharray] { animation-direction: alternate; }
    .arch-edge[data-speed="slow"] .arch-line[stroke-dasharray] { animation-duration: 2.4s; }
    .arch-edge[data-speed="fast"] .arch-line[stroke-dasharray] { animation-duration: .6s; }
    .arch-edge[data-speed="turbo"] .arch-line[stroke-dasharray] { animation-duration: .3s; }
    @keyframes arch-flow { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -14; } }
    .arch-resize { fill: #2563eb; stroke: #dbeafe; stroke-width: 1; cursor: nwse-resize; }
    .arch-tip rect { fill: #0f172af2; stroke: #334155; }
    .arch-tip line { stroke: #1e293b; }
    .tip-title { fill: #e6edf7; font: 600 11px ui-sans-serif, system-ui; }
    .tip-sub { fill: #7c8aa5; font: 400 9px ui-monospace, monospace; }
    .tip-key { fill: #93a3bd; font: 400 10px ui-monospace, monospace; }
    .tip-val { fill: #e6edf7; font: 400 10px ui-monospace, monospace; text-anchor: end; }
    .tip-line { fill: #cbd5e1; font: 400 10px ui-monospace, monospace; }
    .arch-node.dim, .arch-edge.dim { opacity: .18; }
    .arch-flow-band { fill: #0f172aee; stroke: #24344f; }
    .arch-flow-name { fill: #7c8aa5; font: 600 9px ui-sans-serif, system-ui;
                      letter-spacing: .12em; text-transform: uppercase; }
    .arch-flow-index { fill: #7c8aa5; font: 600 11px ui-monospace, monospace; }
    .arch-flow-step { fill: #e6edf7; font: 600 12.5px ui-sans-serif, system-ui; }
    .arch-flow-detail { fill: #8598b5; font: 400 9.5px ui-monospace, monospace; }
    .arch-flow-track { fill: #1e293b; }
    .arch-token-halo { opacity: .18; }
    .arch-token-ring { fill: none; stroke-width: 1.4; opacity: .55; }
    .arch-node, .arch-edge { transition: opacity .12s ease; }
  `],
})
export class ArchDiagramComponent implements OnDestroy {
  @ViewChild('svg', { static: true }) svgRef!: ElementRef<SVGSVGElement>;

  @Input({ required: true }) set model(value: DiagramModel) {
    this._model.set(value);
  }
  get model(): DiagramModel { return this._model(); }

  /** How unplaced nodes get positioned. Manual leaves the model alone. */
  @Input() set mode(value: LayoutMode) { this._mode.set(value); }

  /** Turns on dragging and selection. Off for a read-only picture. */
  @Input() editable = false;

  /** Fades everything not connected to whatever the pointer is over. */
  @Input() highlight = true;

  /**
   * Which flow to show, by id. Null shows none and restores hover highlighting.
   * Changing it rewinds to the first hop.
   */
  @Input() set flow(value: string | null) {
    if (value === this._flowId()) return;
    this._flowId.set(value);
    this.flowElapsed.set(0);
  }
  get flow(): string | null { return this._flowId(); }

  /** Whether the flow's clock is running. A paused flow still shows its hop. */
  @Input() set flowPlaying(value: boolean) {
    if (value) this.startClock(); else this.stopClock();
  }

  @Input() selectedId: string | null = null;
  @Input() selectedEdgeId: string | null = null;
  @Input() selectedGroupId: string | null = null;

  @Output() nodeSelected = new EventEmitter<string | null>();
  @Output() edgeSelected = new EventEmitter<string | null>();
  @Output() groupSelected = new EventEmitter<string | null>();
  /** A step of a container drag, as a whole-pixel delta to apply to its contents. */
  @Output() groupMoved = new EventEmitter<{ id: string; dx: number; dy: number }>();
  @Output() nodeMoved = new EventEmitter<{ id: string; x: number; y: number }>();
  @Output() nodeResized = new EventEmitter<{ id: string; width: number; height: number }>();
  @Output() canvasClicked = new EventEmitter<{ x: number; y: number }>();

  private _model = signal<DiagramModel>({ categories: [], groups: [], nodes: [], edges: [] });
  private _mode = signal<LayoutMode>('manual');
  hovered = signal<string | null>(null);

  private pan = signal({ x: 0, y: 0, w: 1600, h: 900 });
  private drag: { id: string; dx: number; dy: number } | null = null;
  private resizing: { id: string; w: number; h: number; px: number; py: number; uniform: boolean } | null = null;
  /** Where the pointer was when the container last stepped, in diagram units. */
  private groupDrag: { id: string; x: number; y: number } | null = null;
  private panning: { x: number; y: number } | null = null;

  readonly view = computed(() => layout(this._model(), this._mode()));

  viewBox = computed(() => {
    const p = this.pan();
    return `${p.x} ${p.y} ${p.w} ${p.h}`;
  });

  /**
   * Edge geometry: an orthogonal elbow, which reads better than a diagonal.
   * Each edge leaves the side of its source that faces the target — sideways
   * when the pair reads left/right, top/bottom when it reads stacked — so a
   * connector never doubles back through its own box.
   */
  readonly edges = computed(() => {
    const model = this._model();
    const view = this.view();

    // A link may be anchored to a container as readily as to a box: both are
    // rectangles on the canvas, and that is all the geometry below needs.
    const placed = new Map<string, { x: number; y: number; width: number; height: number; categoryId?: string }>();
    for (const g of view.groups) placed.set(g.id, g);
    for (const n of view.nodes) placed.set(n.id, n);

    return model.edges.flatMap((e) => {
      const a = placed.get(e.from);
      const b = placed.get(e.to);
      if (!a || !b) return [];

      const acx = a.x + a.width / 2, acy = a.y + a.height / 2;
      const bcx = b.x + b.width / 2, bcy = b.y + b.height / 2;
      let path: string, arrow: string, tail: string, lx: number, ly: number;
      // The same elbow as a polyline. The corner arcs are a few pixels wide,
      // so a dot walking the corners square is indistinguishable from one
      // walking the drawn path — and needs no rendered element to measure.
      let pts: { x: number; y: number }[];

      // A link that names its sides keeps them; otherwise the pair that faces
      // the other end is used.
      const sideways = e.route
        ? e.route === 'side'
        : Math.abs(bcx - acx) >= Math.abs(bcy - acy);

      if (sideways) {
        // Side to side, elbowing through the horizontal midpoint.
        const hd = Math.sign(bcx - acx) || 1;
        const x1 = acx + (a.width / 2) * hd;
        const x2 = bcx - (b.width / 2) * hd;
        // Near enough to level reads as an error rather than as intent, so
        // meet in the middle and draw it truly level.
        let y1 = acy, y2 = bcy;
        if (Math.abs(y2 - y1) <= SNAP_UNITS) y1 = y2 = (y1 + y2) / 2;
        const mid = (x1 + x2) / 2;
        const vd = Math.sign(y2 - y1) || 1;
        const r = corner(x2 - x1, y2 - y1);
        path = Math.abs(y2 - y1) < 4
          ? `M ${x1} ${y1} L ${x2} ${y2}`
          : `M ${x1} ${y1} L ${mid - r * hd} ${y1} Q ${mid} ${y1} ${mid} ${y1 + r * vd}` +
            ` L ${mid} ${y2 - r * vd} Q ${mid} ${y2} ${mid + r * hd} ${y2} L ${x2} ${y2}`;
        arrow = `M ${x2} ${y2} l ${-9 * hd} -4.5 l 0 9 z`;
        tail = `M ${x1} ${y1} l ${9 * hd} -4.5 l 0 9 z`;
        lx = mid; ly = (y1 + y2) / 2 - 6;
        pts = Math.abs(y2 - y1) < 4
          ? [{ x: x1, y: y1 }, { x: x2, y: y2 }]
          : [{ x: x1, y: y1 }, { x: mid, y: y1 }, { x: mid, y: y2 }, { x: x2, y: y2 }];
      } else {
        // Stacked, elbowing through the vertical midpoint.
        const vd = Math.sign(bcy - acy) || 1;
        const y1 = acy + (a.height / 2) * vd;
        const y2 = bcy - (b.height / 2) * vd;
        let x1 = acx, x2 = bcx;
        if (Math.abs(x2 - x1) <= SNAP_UNITS) x1 = x2 = (x1 + x2) / 2;
        const mid = (y1 + y2) / 2;
        const hd = Math.sign(x2 - x1) || 1;
        const r = corner(x2 - x1, y2 - y1);
        path = Math.abs(x2 - x1) < 4
          ? `M ${x1} ${y1} L ${x2} ${y2}`
          : `M ${x1} ${y1} L ${x1} ${mid - r * vd} Q ${x1} ${mid} ${x1 + r * hd} ${mid}` +
            ` L ${x2 - r * hd} ${mid} Q ${x2} ${mid} ${x2} ${mid + r * vd} L ${x2} ${y2}`;
        arrow = `M ${x2} ${y2} l -4.5 ${-9 * vd} l 9 0 z`;
        tail = `M ${x1} ${y1} l -4.5 ${9 * vd} l 9 0 z`;
        lx = (x1 + x2) / 2; ly = mid - 6;
        pts = Math.abs(x2 - x1) < 4
          ? [{ x: x1, y: y1 }, { x: x2, y: y2 }]
          : [{ x: x1, y: y1 }, { x: x1, y: mid }, { x: x2, y: mid }, { x: x2, y: y2 }];
      }

      return [{
        id: e.id,
        from: e.from,
        to: e.to,
        label: e.label,
        path,
        pts,
        arrow,
        tail: e.dir === 'both' ? tail : null,
        lx,
        ly,
        labelW: e.label ? labelWidth(e.label) : 0,
        speed: e.speed ?? 'normal',
        color: e.color ?? hexA(
          a.categoryId ? categoryColor(model, a.categoryId) : GROUP_NEUTRAL, 0.75,
        ),
        // Long dashes by default, like the infra panel's connectors. The
        // patterns repeat every 14px and 7px, so one -14px flow loops both.
        dash: e.kind === 'dotted' ? '3 4' : e.kind === 'solid' ? null : '8 6',
      }];
    });
  });

  color(categoryId: string): string { return categoryColor(this._model(), categoryId); }
  nodeFill(categoryId: string): string { return hexA(this.color(categoryId), 0.1); }
  groupColor(categoryId?: string): string {
    return categoryId ? this.color(categoryId) : GROUP_NEUTRAL;
  }
  groupFill(categoryId?: string): string { return hexA(this.groupColor(categoryId), 0.04); }
  groupIcon(g: { kind?: string; icon?: string }): string | null {
    return g.icon ?? (g.kind === 'network' ? '▦' : null);
  }

  /** The drawn icon behind any `@name`, wherever an icon can appear. */
  vectorFor(icon: string): string | null { return vectorIconPath(icon); }

  /** Puts a drawn container icon where the typed one sits in the label band. */
  groupIconTransform(g: PlacedGroup): string {
    return `translate(${g.x + 13},${g.y + 17 - GROUP_ICON_PX / 2}) scale(${GROUP_ICON_PX / 24})`;
  }
  icon(node: DiagramNode): string { return nodeIcon(this._model(), node, DEFAULT_TYPE_ICONS); }

  /**
   * Whether to draw an icon at all.
   *
   * <p>A box already drawn as a barrel does not need a picture of a barrel
   * inside it, so the generic database icon is dropped there — name an engine
   * and its own mark comes back.</p>
   */
  showIcon(node: DiagramNode): boolean {
    return !(node.shape === 'cylinder' && this.icon(node) === '@database');
  }

  /** Where the title starts, which is further in only when an icon precedes it. */
  titleX(node: DiagramNode): number {
    return this.padX(node) + (this.showIcon(node) ? 22 : 0);
  }

  isRound(node: DiagramNode): boolean { return node.shape === 'circle' || node.shape === 'oval'; }

  /** How deep the lid of a cylinder is, held back on a shallow box. */
  private cylinderRy(n: PlacedNode): number { return Math.min(12, n.height * 0.2); }

  /** The barrel: straight sides, a bulge at the bottom, a lid across the top. */
  cylinderPath(n: PlacedNode): string {
    const ry = this.cylinderRy(n);
    const w = n.width;
    return `M0 ${ry}V${n.height - ry}a${w / 2} ${ry} 0 0 0 ${w} 0V${ry}` +
           `a${w / 2} ${ry} 0 0 0 ${-w} 0Z`;
  }

  /** The near edge of the top ellipse, which is what reads as a lid. */
  cylinderLid(n: PlacedNode): string {
    const ry = this.cylinderRy(n);
    return `M0 ${ry}a${n.width / 2} ${ry} 0 0 0 ${n.width} 0`;
  }

  /** A decision: its four points sit mid-side, which is where links already attach. */
  diamondPath(n: PlacedNode): string {
    const w = n.width, h = n.height;
    return `M${w / 2} 0L${w} ${h / 2}L${w / 2} ${h}L0 ${h / 2}Z`;
  }

  /** A cylinder's text clears its lid rather than straddling it. */
  private textShift(n: PlacedNode): number {
    return n.shape === 'cylinder' ? this.cylinderRy(n) / 2 : 0;
  }
  isCentered(node: DiagramNode): boolean { return node.shape === 'circle' || node.shape === 'square'; }
  /** An ellipse narrows at the sides, so oval text starts further in. */
  padX(node: DiagramNode): number { return node.shape === 'oval' ? 26 : 14; }

  /*
   * Where each line of a box sits.
   *
   * SVG places text by its baseline, not its middle, so centring means
   * dropping the baseline by about half the cap height — 4px for the 11px
   * title, 5px for the 14px icon. A title on its own therefore sits level
   * with the icon; a title with a subtitle under it moves up so the pair
   * still straddles the middle rather than hanging below it.
   */
  iconY(n: PlacedNode): number {
    const base = n.height / 2 + this.textShift(n);
    if (!this.isCentered(n)) return base + 5;
    return base + (n.sublabel ? -9 : -3);
  }

  titleY(n: PlacedNode): number {
    const base = n.height / 2 + this.textShift(n);
    if (!this.isCentered(n)) return base + (n.sublabel ? -2 : 4);
    return base + (n.sublabel ? 8 : 14);
  }

  subY(n: PlacedNode): number {
    return n.height / 2 + this.textShift(n) + (this.isCentered(n) ? 21 : 11);
  }

  /** The drawn icon behind an `@name`, or null when the icon is text. */
  vector(n: DiagramNode): string | null {
    return vectorIconPath(nodeIcon(this._model(), n, DEFAULT_TYPE_ICONS));
  }

  /**
   * Puts a drawn icon where the typed one would have sat: a 24-unit box
   * scaled to the same {@link ICON_PX} the font renders at, centred on the
   * middle of the glyph the text would have drawn — which is `iconY` less
   * about half its cap height.
   */
  iconTransform(n: PlacedNode): string {
    const s = ICON_PX / 24;
    const cx = this.isCentered(n) ? n.width / 2 : this.padX(n) + ICON_PX / 2 - 2;
    const cy = this.iconY(n) - 5;
    return `translate(${cx - ICON_PX / 2},${cy - ICON_PX / 2}) scale(${s})`;
  }

  /**
   * The hover card: label and sublabel as a header, then aligned key/value
   * rows — the node's network facts (IP, subnet, security groups), any
   * generated `props`, and free-form `info` lines (`key: value` becomes a
   * row; anything else stays a plain line).
   */
  readonly tip = computed(() => {
    const id = this.hovered();
    if (!id) return null;
    const n = this.view().nodes.find((v) => v.id === id);
    if (!n) return null;

    const model = this._model();
    const pool = new Map((model.net ?? []).map((e) => [e.id, e]));
    const rows: { k?: string; v?: string; line?: string }[] = [];

    if (n.ip) rows.push({ k: 'ip', v: n.ip });
    const subnet = n.subnetId ? model.groups.find((g) => g.id === n.subnetId) : undefined;
    if (subnet) rows.push({ k: 'subnet', v: `${subnet.label}${subnet.cidr ? ` · ${subnet.cidr}` : ''}` });
    for (const sgId of n.securityGroupIds ?? []) {
      const sg = pool.get(sgId);
      if (sg) rows.push({ k: 'sg', v: sg.name + (sg.note ? ` · ${sg.note}` : '') });
    }
    for (const [k, v] of Object.entries(n.props ?? {})) rows.push({ k, v: String(v) });
    for (const raw of (n.info ?? '').split('\n')) {
      const line = raw.trimEnd();
      if (!line) continue;
      const at = line.indexOf(': ');
      rows.push(at > 0 ? { k: line.slice(0, at), v: line.slice(at + 2) } : { line });
    }
    if (!rows.length) return null;

    const headerW = Math.max(n.label.length * 6.8, (n.sublabel?.length ?? 0) * 6.2) + 24;
    const rowW = Math.max(...rows.map((r) =>
      r.line != null ? r.line.length * 6.2 : (r.k!.length + r.v!.length) * 6.2 + 28)) + 24;
    const headH = n.sublabel ? 40 : 26;
    return {
      x: n.x,
      y: n.y + n.height + 8,
      w: Math.max(headerW, rowW, 140),
      h: headH + rows.length * 15 + 10,
      label: n.label,
      sub: n.sublabel,
      headH,
      rows,
    };
  });

  /** Everything not touching the hovered node fades back. */
  private related = computed(() => {
    const id = this.hovered();
    if (!id) return null;
    const near = new Set<string>([id]);
    for (const e of this._model().edges) {
      if (e.from === id) near.add(e.to);
      if (e.to === id) near.add(e.from);
    }
    return near;
  });

  dimmedNode(id: string): boolean {
    // A playing flow says what matters; the pointer only gets a say when
    // nothing is travelling.
    const frame = this.frame();
    if (frame) return !frame.nodes.has(id);
    if (!this.highlight) return false;
    const near = this.related();
    return !!near && !near.has(id);
  }

  dimmed(from: string, to: string): boolean {
    if (!this.highlight) return false;
    const near = this.related();
    return !!near && !(near.has(from) && near.has(to));
  }

  /** While hovering, whatever stays visible also brightens. */
  litNode(id: string): boolean {
    const frame = this.frame();
    if (frame) {
      return frame.active
        ? id === frame.active.from || id === frame.active.to
        : frame.nodes.has(id);
    }
    if (!this.highlight) return false;
    const near = this.related();
    return !!near && near.has(id);
  }

  lit(from: string, to: string): boolean {
    if (!this.highlight) return false;
    const near = this.related();
    return !!near && near.has(from) && near.has(to);
  }

  /** Per link rather than per pair, so two links between one pair differ. */
  dimmedEdge(e: { id: string; from: string; to: string }): boolean {
    const frame = this.frame();
    if (frame) return !frame.edges.has(e.id) && frame.active?.edgeId !== e.id;
    return this.dimmed(e.from, e.to);
  }

  litEdge(e: { id: string; from: string; to: string }): boolean {
    const frame = this.frame();
    if (frame) return frame.active?.edgeId === e.id;
    return this.lit(e.from, e.to);
  }

  // ---- flows --------------------------------------------------------------

  private readonly _flowId = signal<string | null>(null);

  /** Where the flow clock stands, in milliseconds into the loop. */
  readonly flowElapsed = signal(0);
  private raf = 0;
  private clockFrom = 0;

  /** The flow being shown, if it exists on the model and has hops. */
  readonly activeFlow = computed<DiagramFlow | null>(() => {
    const id = this._flowId();
    if (!id) return null;
    const found = (this._model().flows ?? []).find((f) => f.id === id);
    return found && found.steps.length ? found : null;
  });

  /**
   * How long one beat lasts for the flow on show.
   *
   * <p>Rounded to a whole number of 300ms and never shorter than that: the
   * dashes on the hop being travelled turn over every 300ms, so a beat that
   * was not a multiple of it would leave them mid-pattern when the loop came
   * round, and an exported GIF would show a seam.</p>
   */
  readonly beatMs = computed(() => {
    const wanted = this.activeFlow()?.beatMs ?? FLOW_BEAT_MS;
    return Math.max(FLOW_BEAT_STEP_MS,
      Math.round(wanted / FLOW_BEAT_STEP_MS) * FLOW_BEAT_STEP_MS);
  });

  /**
   * The journey resolved: where each hop starts and ends, which way it runs
   * along its link, and the beats it occupies.
   *
   * <p>Walking the path is what makes direction free. The step says where it
   * is going; if the link it names points the other way, the hop simply runs
   * against the arrow.</p>
   */
  readonly hops = computed(() => {
    const flow = this.activeFlow();
    if (!flow) return [];
    const byId = new Map(this._model().edges.map((e) => [e.id, e]));

    let cursor = flow.from;
    let beat = 0;
    return flow.steps.map((step, index) => {
      const edge = step.edgeId ? byId.get(step.edgeId) : undefined;
      const beats = Math.max(1, step.beats ?? 1);
      const hop = {
        step, index,
        from: cursor,
        to: step.to,
        edgeId: edge?.id,
        // Against the arrow when the path arrived at the link's far end.
        reverse: !!edge && edge.to === cursor && edge.from !== cursor,
        beatFrom: beat,
        beatTo: beat + beats,
      };
      beat += beats;
      cursor = step.to;
      return hop;
    });
  });

  /** How long the journey takes, the pause at the end included. */
  readonly flowLoopMs = computed(() => {
    const flow = this.activeFlow();
    const hops = this.hops();
    if (!flow || !hops.length) return 0;
    return (hops[hops.length - 1].beatTo + Math.max(0, flow.restBeats ?? 2)) * this.beatMs();
  });

  /**
   * The flow at a given millisecond.
   *
   * <p>Nothing here reads a clock, which is the point: the canvas asks for the
   * clock's reading and an export asks for each frame's, and the same
   * millisecond gives the same answer to both.</p>
   */
  frameAt(elapsed: number): FlowFrame | null {
    const flow = this.activeFlow();
    const hops = this.hops();
    const loop = this.flowLoopMs();
    if (!flow || !hops.length || !loop) return null;

    const within = ((elapsed % loop) + loop) % loop;
    const beat = within / this.beatMs();
    // The path has always left its starting point, whatever else it has done.
    const nodes = new Set<string>([flow.from]);
    const edges = new Set<string>();
    let active: FlowFrame['active'] = null;
    let index = hops.length - 1;

    for (const hop of hops) {
      if (beat >= hop.beatTo) {
        nodes.add(hop.to);
        if (hop.edgeId) edges.add(hop.edgeId);
      } else if (beat >= hop.beatFrom) {
        active = {
          edgeId: hop.edgeId,
          from: hop.from,
          to: hop.to,
          reverse: hop.reverse,
          t: (beat - hop.beatFrom) / (hop.beatTo - hop.beatFrom),
        };
        index = hop.index;
      }
    }

    // During the pause the journey is over, so it reads as the final arrival
    // rather than as nothing at all.
    const hop = hops[index];
    return {
      index,
      active,
      caption: {
        index: `${index + 1} / ${hops.length}`,
        step: this.hopText(hop),
        detail: hop.step.detail ?? '',
      },
      nodes,
      edges,
      progress: within / loop,
    };
  }

  /** The flow as the canvas is showing it now. Null when none is selected. */
  readonly frame = computed(() => this.frameAt(this.flowElapsed()));

  /**
   * Where the travelling dot sits, or null while the flow rests.
   *
   * <p>A hop along a link walks that link's elbow. A hop into a container goes
   * straight there, because containment has no drawn route to follow.</p>
   */
  tokenAt(frame: FlowFrame): { x: number; y: number } | null {
    const at = frame.active;
    if (!at) return null;

    if (at.edgeId) {
      const geo = this.edges().find((e) => e.id === at.edgeId);
      if (geo) return pointAlong(at.reverse ? [...geo.pts].reverse() : geo.pts, at.t);
    }

    const from = this.placed(at.from);
    const to = this.placed(at.to);
    if (!from || !to) return null;
    return pointAlong([centre(from), centre(to)], at.t);
  }

  /** A box or a container by id, whichever the id names. */
  private placed(id: string): { x: number; y: number; width: number; height: number } | null {
    const v = this.view();
    return v.nodes.find((n) => n.id === id) ?? v.groups.find((g) => g.id === id) ?? null;
  }

  /** What a hop is called: its own words, else its link's, else where it lands. */
  private hopText(hop: { step: FlowStep; to: string; edgeId?: string }): string {
    if (hop.step.label) return hop.step.label;
    const model = this._model();
    const viaLabel = hop.edgeId
      ? model.edges.find((e) => e.id === hop.edgeId)?.label
      : undefined;
    if (viaLabel) return viaLabel;
    return model.nodes.find((n) => n.id === hop.to)?.label
      ?? model.groups.find((g) => g.id === hop.to)?.label
      ?? 'in transit';
  }

  /**
   * The caption band, sized to the longest line any hop will ever show.
   *
   * <p>Fixed width on purpose: an export measures the picture once and then
   * paints every frame into that frame, so a band that grew with the words
   * would push a later caption outside the picture.</p>
   */
  readonly banner = computed(() => {
    const flow = this.activeFlow();
    const frame = this.frame();
    if (!flow || !frame) return null;

    const box = this.laidOutBox();
    const hops = this.hops();
    const widest = Math.max(
      0,
      ...hops.map((h) => measure(this.hopText(h), BANNER_STEP_FONT)),
      ...hops.map((h) => measure(h.step.detail ?? '', BANNER_DETAIL_FONT)),
    );

    return {
      x: box.x,
      y: box.y - BANNER_H - BANNER_GAP,
      w: Math.max(BANNER_MIN_W, box.w, BANNER_TEXT_X + widest + 16),
      h: BANNER_H,
      name: flow.label,
      color: flow.color ?? '#fbbf24',
      index: frame.caption.index,
      step: frame.caption.step,
      detail: frame.caption.detail,
      progress: frame.progress,
      token: this.tokenAt(frame),
    };
  });

  /** Runs the flow clock. Harmless to call twice. */
  private startClock(): void {
    if (this.raf || typeof requestAnimationFrame === 'undefined') return;
    this.clockFrom = performance.now() - this.flowElapsed();
    const tick = (now: number): void => {
      const loop = this.flowLoopMs();
      this.flowElapsed.set(loop ? (now - this.clockFrom) % loop : 0);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopClock(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Jumps to the start of one hop, for stepping through by hand. */
  seekStep(index: number): void {
    const hops = this.hops();
    if (!hops.length) return;
    const hop = hops[Math.max(0, Math.min(index, hops.length - 1))];
    this.flowElapsed.set(hop.beatFrom * this.beatMs());
    this.clockFrom = performance.now() - this.flowElapsed();
  }

  ngOnDestroy(): void {
    this.stopClock();
  }

  // ---- interaction --------------------------------------------------------

  /**
   * Announces what is selected now.
   *
   * <p>All three outputs fire on every selection, so a listener sees the
   * whole picture and does not have to clear the others itself — which it
   * could only get right by knowing what order they arrive in.</p>
   */
  private announce(nodeId: string | null, edgeId: string | null, groupId: string | null): void {
    this.selectedId = nodeId;
    this.selectedEdgeId = edgeId;
    this.selectedGroupId = groupId;
    this.nodeSelected.emit(nodeId);
    this.edgeSelected.emit(edgeId);
    this.groupSelected.emit(groupId);
  }

  onEdgeDown(event: PointerEvent, edgeId: string): void {
    event.stopPropagation();
    this.announce(null, edgeId, null);
  }

  onNodeDown(event: PointerEvent, node: PlacedNode): void {
    event.stopPropagation();
    this.announce(node.id, null, null);
    if (!this.editable) return;

    const p = this.toDiagram(event);
    this.drag = { id: node.id, dx: p.x - node.x, dy: p.y - node.y };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }

  onResizeDown(event: PointerEvent, node: PlacedNode): void {
    event.stopPropagation();
    if (!this.editable) return;
    const p = this.toDiagram(event);
    this.resizing = {
      id: node.id,
      w: node.width, h: node.height,
      px: p.x, py: p.y,
      // Square and circle stay square while dragged.
      uniform: node.shape === 'square' || node.shape === 'circle',
    };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }

  onGroupDown(event: PointerEvent, _groupId: string): void {
    // The body of a container is scenery: grabbing empty space inside a box
    // pans, which is what people expect. Its header is the handle instead.
    this.onCanvasDown(event);
  }

  /**
   * Starts moving a whole container. Only the label band does this, so that
   * dragging the empty space inside a large container still pans the canvas.
   */
  onGroupHeadDown(event: PointerEvent, group: PlacedGroup): void {
    event.stopPropagation();
    this.announce(null, null, group.id);
    if (!this.editable) return;

    const p = this.toDiagram(event);
    this.groupDrag = { id: group.id, x: p.x, y: p.y };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  }

  onCanvasDown(event: PointerEvent): void {
    this.announce(null, null, null);
    const p = this.toDiagram(event);
    this.canvasClicked.emit(p);
    this.panning = { x: event.clientX, y: event.clientY };
  }

  onMove(event: PointerEvent): void {
    if (this.groupDrag) {
      const p = this.toDiagram(event);
      const dx = Math.round(p.x - this.groupDrag.x);
      const dy = Math.round(p.y - this.groupDrag.y);
      if (dx || dy) {
        this.groupMoved.emit({ id: this.groupDrag.id, dx, dy });
        // Advance by exactly what was emitted, so the fraction left over is
        // carried into the next step rather than lost — otherwise a slow drag
        // rounds itself to a standstill.
        this.groupDrag = { id: this.groupDrag.id, x: this.groupDrag.x + dx, y: this.groupDrag.y + dy };
      }
      return;
    }

    if (this.resizing) {
      const p = this.toDiagram(event);
      let w = this.resizing.w + (p.x - this.resizing.px);
      let h = this.resizing.h + (p.y - this.resizing.py);
      if (this.resizing.uniform) w = h = Math.max(w, h);
      this.nodeResized.emit({
        id: this.resizing.id,
        width: Math.max(40, Math.round(w)),
        height: Math.max(28, Math.round(h)),
      });
      return;
    }

    if (this.drag) {
      const p = this.toDiagram(event);
      this.nodeMoved.emit({
        id: this.drag.id,
        x: Math.round(p.x - this.drag.dx),
        y: Math.round(p.y - this.drag.dy),
      });
      return;
    }

    if (this.panning) {
      const scale = this.pan().w / (this.svgRef.nativeElement.clientWidth || 1);
      const dx = (event.clientX - this.panning.x) * scale;
      const dy = (event.clientY - this.panning.y) * scale;
      this.panning = { x: event.clientX, y: event.clientY };
      this.pan.update((p) => ({ ...p, x: p.x - dx, y: p.y - dy }));
    }
  }

  onUp(): void {
    this.drag = null;
    this.resizing = null;
    this.groupDrag = null;
    this.panning = null;
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 1.1 : 0.9;
    const p = this.toDiagram(event as unknown as PointerEvent);
    this.pan.update((v) => ({
      // Zoom toward the pointer rather than the corner.
      x: p.x - (p.x - v.x) * factor,
      y: p.y - (p.y - v.y) * factor,
      w: v.w * factor,
      h: v.h * factor,
    }));
  }

  /**
   * Everything the canvas draws, measured from what is on screen.
   *
   * <p>Measured rather than worked out, because plenty of what a diagram
   * draws is not the size of the thing it belongs to. A container's name is
   * written from its corner and a long one runs well past its border; a title
   * wider than its box overhangs the same way. Adding up shapes misses all of
   * it, and whatever is missed gets quietly cropped out of an export.</p>
   *
   * <p>Selection handles and the hover card are hidden for the measurement:
   * they are editor furniture, and they are stripped from an export too, so
   * counting them would leave a margin that has nothing in it.</p>
   */
  contentBox(): { x: number; y: number; w: number; h: number } {
    const svg = this.svgRef?.nativeElement;
    if (svg) {
      const chrome = Array.from(svg.querySelectorAll('.arch-resize, .arch-tip'));
      chrome.forEach((el) => el.setAttribute('display', 'none'));
      let drawn: DOMRect | null = null;
      try { drawn = svg.getBBox(); } catch { drawn = null; }
      chrome.forEach((el) => el.removeAttribute('display'));

      if (drawn && drawn.width > 0 && drawn.height > 0) {
        return { x: drawn.x, y: drawn.y, w: drawn.width, h: drawn.height };
      }
    }
    return this.laidOutBox();
  }

  /**
   * The same box worked out from the layout, for when there is nothing
   * rendered to measure. Shapes and connector labels only, so it can fall
   * short of what text actually occupies.
   */
  private readonly laidOutBox = computed(() => {
    const v = this.view();
    let left = v.x, top = v.y, right = v.x + v.width, bottom = v.y + v.height;

    for (const e of this.edges()) {
      if (!e.label) continue;
      left = Math.min(left, e.lx - e.labelW / 2 - 5);
      right = Math.max(right, e.lx + e.labelW / 2 + 5);
      top = Math.min(top, e.ly - 10.5);
      bottom = Math.max(bottom, e.ly + 3.5);
    }
    return { x: left, y: top, w: right - left, h: bottom - top };
  });

  /** Frames the whole diagram. */
  fit(): void {
    const b = this.contentBox();
    this.pan.set({
      x: b.x - FRAME_PAD,
      y: b.y - FRAME_PAD,
      w: b.w + FRAME_PAD * 2,
      h: b.h + FRAME_PAD * 2,
    });
  }

  zoom(factor: number): void {
    this.pan.update((v) => {
      const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
      const w = v.w * factor, h = v.h * factor;
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    });
  }

  /**
   * Renders the whole diagram as a sequence of still frames, one animation
   * loop long.
   *
   * <p>The frames are produced by cloning the SVG and setting each dash
   * offset by hand rather than by waiting on the running animation, so a
   * capture is deterministic and the last frame hands back to the first
   * exactly — which is what makes an exported GIF loop without a seam.
   * Frames are handed over one at a time because holding fifty full-size
   * bitmaps at once is a great deal of memory.</p>
   */
  /**
   * What a capture would produce, without producing it.
   *
   * <p>The same arithmetic the capture itself uses, so what an editor promises
   * is what it hands over. Cheap enough to ask before every export, though it
   * measures the drawing, so not worth asking on every animation frame.</p>
   */
  capturePlan(options: CaptureOptions = {}): CapturePlan {
    const {
      maxWidth = 3000, maxScale = 4,
      pixelBudget = 3e8, maxFramePixels = FRAME_PIXEL_CAP,
    } = options;

    const loopMs = this.loopMs();
    // Both delays divide every beat and every dash period, so halving the rate
    // for a long journey still lands the last frame back on the first. A flow
    // at its quickest keeps the higher rate whatever its length: three frames
    // a hop is a stutter, not an animation.
    const quick = this.activeFlow() ? this.beatMs() <= FLOW_BEAT_STEP_MS : loopMs <= LONG_LOOP_MS;
    const delayMs = quick ? CAPTURE_DELAY_MS : SLOW_CAPTURE_DELAY_MS;
    const frames = loopMs ? Math.round(loopMs / delayMs) : 1;

    const measured = this.contentBox();
    const box = { w: measured.w + FRAME_PAD * 2, h: measured.h + FRAME_PAD * 2 };

    // Worth drawing a small diagram larger than life so it stays crisp, but
    // every pixel is paid for once per frame — so the budget is spread over
    // the whole loop, and a short loop is drawn larger than a long one. Each
    // frame is capped in its own right as well, since a long journey rendered
    // huge makes a file nobody can send anywhere.
    const scale = Math.min(
      maxScale,
      maxWidth / box.w,
      Math.sqrt(pixelBudget / (frames * box.w * box.h)),
      Math.sqrt(maxFramePixels / (box.w * box.h)),
    );
    const width = Math.max(1, Math.round(box.w * scale));
    const height = Math.max(1, Math.round(box.h * scale));

    return {
      frames, delayMs, loopMs, width, height,
      bytes: Math.round(frames * gifFrameBytes(width, height)),
    };
  }

  async captureLoop(
    onFrame: (pixels: Uint8ClampedArray, width: number, height: number, index: number) => void,
    options: CaptureOptions = {},
  ): Promise<CapturePlan> {
    const plan = this.capturePlan(options);
    const { frames, delayMs, loopMs, width, height } = plan;
    const flowing = !!this.activeFlow();

    const { clone, lines } = this.staticClone();
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

    for (let i = 0; i < frames; i++) {
      const elapsed = (i / frames) * loopMs;
      if (flowing) this.paintFlow(clone, lines, elapsed);
      else this.paintDashes(lines, elapsed);

      const svgText = new XMLSerializer().serializeToString(clone);
      const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`);
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
      onFrame(ctx.getImageData(0, 0, width, height).data, width, height, i);
    }

    return plan;
  }

  /** Every dashed link at the offset its own animation would be showing. */
  private paintDashes(lines: SVGPathElement[], elapsed: number): void {
    for (const path of lines) {
      const group = path.parentElement as SVGGElement | null;
      const speed = (group?.getAttribute('data-speed') ?? 'normal') as EdgeSpeed;
      const period = EDGE_SPEED_MS[speed] ?? EDGE_SPEED_MS.normal;
      // A one-way dash runs the pattern over and over; a two-way one
      // traverses it and comes back, so its cycle is twice as long.
      const both = group?.classList.contains('bidir');
      const turn = both ? (elapsed / (period * 2)) % 1 : (elapsed / period) % 1;
      const phase = both ? 1 - Math.abs(2 * turn - 1) : turn;
      path.setAttribute('stroke-dashoffset', String(-DASH_PERIOD * phase));
    }
  }

  /**
   * One frame of a journey, written straight onto the detached copy.
   *
   * <p>The same state the template binds, applied by hand because a capture
   * cannot wait for change detection between frames. Only the hop in transit
   * has moving dashes, at a rate that divides the beat, so the loop closes.</p>
   */
  private paintFlow(clone: SVGSVGElement, lines: SVGPathElement[], elapsed: number): void {
    const frame = this.frameAt(elapsed);
    if (!frame) return;

    const turn = (elapsed / FLOW_DASH_MS) % 1;
    for (const path of lines) {
      const id = (path.parentElement as SVGGElement | null)?.getAttribute('data-id');
      const moving = !!frame.active && id === frame.active.edgeId;
      const offset = !moving ? 0
        : frame.active!.reverse ? DASH_PERIOD * turn
        : -DASH_PERIOD * turn;
      path.setAttribute('stroke-dashoffset', String(offset));
    }

    clone.querySelectorAll('.arch-edge').forEach((el) => {
      const id = el.getAttribute('data-id') ?? '';
      el.classList.toggle('lit', frame.active?.edgeId === id);
      el.classList.toggle('dim', !frame.edges.has(id) && frame.active?.edgeId !== id);
    });
    clone.querySelectorAll('.arch-node').forEach((el) => {
      const id = el.getAttribute('data-id') ?? '';
      el.classList.toggle('dim', !frame.nodes.has(id));
      el.classList.toggle(
        'lit',
        !!frame.active && (id === frame.active.from || id === frame.active.to),
      );
    });
    clone.querySelectorAll('.arch-group').forEach((el) => {
      const id = el.getAttribute('data-id') ?? '';
      el.classList.toggle(
        'lit',
        frame.active ? id === frame.active.from || id === frame.active.to : frame.nodes.has(id),
      );
    });

    const token = clone.querySelector('.arch-token');
    const at = this.tokenAt(frame);
    if (token && at) {
      token.removeAttribute('display');
      token.setAttribute('transform', `translate(${at.x},${at.y})`);
    } else if (token) {
      token.setAttribute('display', 'none');
    }

    const write = (selector: string, text: string): void => {
      const el = clone.querySelector(selector);
      if (el) el.textContent = text;
    };
    write('.arch-flow-index', frame.caption.index);
    write('.arch-flow-step', frame.caption.step);
    write('.arch-flow-detail', frame.caption.detail);

    const band = this.banner();
    const fill = clone.querySelector('.arch-flow-fill');
    if (band && fill) fill.setAttribute('width', String(band.w * frame.progress));
  }

  /**
   * The whole diagram as a still image, drawn at `scale` device pixels per
   * diagram unit — 3 gives a picture that stands up to a large screen or a
   * printed page, where matching the on-screen size would look soft.
   *
   * <p>Capped by total pixels rather than width alone, since a tall diagram
   * at a high scale can exhaust canvas memory just as easily as a wide one.</p>
   */
  async renderStill(scale = 3, maxPixels = 3.2e7): Promise<Blob> {
    const { clone, box } = this.staticClone();
    const fit = Math.min(scale, Math.sqrt(maxPixels / (box.w * box.h)));
    const width = Math.max(1, Math.round(box.w * fit));
    const height = Math.max(1, Math.round(box.h * fit));
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const svgText = new XMLSerializer().serializeToString(clone);
    const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`);
    ctx.drawImage(image, 0, 0, width, height);

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))),
        'image/png',
      );
    });
  }

  /**
   * A detached copy of the canvas, framed on the whole diagram and carrying
   * its own styles, ready to be serialised and rasterised.
   *
   * <p>The component's scoped rules still match it, since the clone keeps its
   * content attributes, so only the animation rules need dropping: a still
   * has to take its dash offset from an attribute rather than from whatever
   * a paused keyframe would impose.</p>
   */
  private staticClone(): {
    clone: SVGSVGElement;
    box: { x: number; y: number; w: number; h: number };
    lines: SVGPathElement[];
  } {
    const b = this.contentBox();
    const box = {
      x: b.x - FRAME_PAD,
      y: b.y - FRAME_PAD,
      w: b.w + FRAME_PAD * 2,
      h: b.h + FRAME_PAD * 2,
    };

    const clone = this.svgRef.nativeElement.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
    // Editor chrome and hover state are not part of the picture.
    clone.querySelectorAll('.arch-resize, .arch-tip, .arch-hit').forEach((el) => el.remove());
    clone.querySelectorAll('.dim, .lit').forEach((el) => el.classList.remove('dim', 'lit'));

    const css = Array.from(document.styleSheets)
      .flatMap((sheet) => {
        try { return Array.from(sheet.cssRules).map((r) => r.cssText); } catch { return []; }
      })
      .filter((text) => text.includes('arch-') && !/animation|@keyframes/.test(text))
      .join('\n');

    const style = document.createElementNS(SVG_NS, 'style');
    style.textContent = css;
    clone.insertBefore(style, clone.firstChild);

    // Overhangs the frame, so the rasteriser cannot leave a half-transparent
    // line of its own antialiasing around the edge of the picture.
    const bleed = 4;
    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('x', String(box.x - bleed));
    bg.setAttribute('y', String(box.y - bleed));
    bg.setAttribute('width', String(box.w + bleed * 2));
    bg.setAttribute('height', String(box.h + bleed * 2));
    bg.setAttribute('fill', CANVAS_BG);
    clone.insertBefore(bg, style.nextSibling);

    const lines = Array.from(clone.querySelectorAll('.arch-line')).filter(
      (p) => p.getAttribute('stroke-dasharray'),
    ) as SVGPathElement[];

    return { clone, box, lines };
  }

  /**
   * How long until every link animation is back where it started, in
   * milliseconds; zero when nothing on the canvas moves.
   *
   * <p>That is the longest cycle in play, not some product of them all: every
   * speed is 300ms times a power of two, so the slowest link's cycle is a
   * whole multiple of each faster one. A two-way link counts double, since it
   * only returns to its start after travelling out and back.</p>
   */
  readonly loopMs = computed(() => {
    // A flow is its own loop. While one plays every link but the travelling
    // one holds still, so there is nothing else to come back into step with.
    const flow = this.flowLoopMs();
    if (flow) return flow;

    const cycles = this.edges()
      .filter((e) => e.dash)
      .map((e) => EDGE_SPEED_MS[e.speed] * (e.tail ? 2 : 1));
    return cycles.length ? Math.max(...cycles) : 0;
  });

  /** Screen point to diagram coordinates. */
  private toDiagram(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const svg = this.svgRef.nativeElement;
    const rect = svg.getBoundingClientRect();
    const p = this.pan();
    return {
      x: p.x + ((event.clientX - rect.left) / rect.width) * p.w,
      y: p.y + ((event.clientY - rect.top) / rect.height) * p.h,
    };
  }
}

export { NODE_W, NODE_H };
