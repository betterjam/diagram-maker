import { Component, HostListener, ViewChild, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import {
  ArchDiagramComponent, DiagramModel, DiagramNode, DiagramEdge, DiagramGroup, NetEntity,
  DiagramFlow, FlowStep, CaptureOptions, CapturePlan, FLOW_PACES,
  DEFAULT_CATEGORIES, DEFAULT_TYPE_ICONS, ICON_LIBRARY, EdgeSpeed, LayoutMode, NodeShape,
  emptyDiagram, vectorIconPath, withDefaultCategories,
} from 'arch-diagram';

const STORAGE_KEY = 'arch-draw:diagram';
const id = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

/** Roughly how much frame data to hold while building a GIF's palette. */
const HELD_FRAME_BYTES = 96e6;

/**
 * A thinned-out sample of the given frames, as one RGBA block for the
 * quantiser to read colours from.
 *
 * <p>Skipping pixels keeps the sample affordable at any resolution while
 * changing little about which colours are present — a diagram is broad flat
 * areas, so its palette survives sampling. The block is sized exactly: the
 * quantiser reads the whole underlying buffer, so slack on the end would
 * register as a run of black pixels that is not in the picture.</p>
 */
const samplePixels = (frames: Uint8Array[], maxPixels = 4e6): Uint8Array => {
  const pixels = frames.reduce((n, f) => n + f.length / 4, 0);
  const stride = Math.max(2, Math.ceil(pixels / maxPixels));
  const step = stride * 4;

  const taken = frames.reduce((n, f) => n + Math.ceil(f.length / step), 0);
  const out = new Uint8Array(taken * 4);
  let at = 0;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += step) {
      out[at++] = frame[i];
      out[at++] = frame[i + 1];
      out[at++] = frame[i + 2];
      out[at++] = frame[i + 3];
    }
  }
  return out;
};

/**
 * A canvas for drawing architecture diagrams by hand.
 *
 * <p>It edits the same model the infra panel generates, so a diagram scanned
 * from live AWS can be opened here, rearranged, annotated and saved back. Drag
 * a node and it gains coordinates, which is all "hand-placed" means — the
 * layout then leaves it alone forever after.</p>
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ArchDiagramComponent],
  template: `
  <!-- one picker, used by whatever is selected -->
  <ng-template #picker let-current let-kind="kind" let-id="id" let-head="head">
    <div class="f">
      <div class="ico-head">
        <span>{{ head }}</span>
        <button class="mini" [class.on]="!current" (click)="setIcon(kind, id, undefined)">auto</button>
      </div>
      @for (s of iconLibrary; track s.label) {
        <span class="ico-group">{{ s.label }}</span>
        <div class="glyphs">
          @for (g of s.icons; track g.char) {
            <button class="glyph" [class.on]="current === g.char" [title]="g.label"
                    (click)="setIcon(kind, id, g.char)">
              @if (vectorPath(g.char); as d) {
                <svg class="vico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="d" /></svg>
              } @else {
                {{ g.char }}
              }
            </button>
          }
        </div>
      }
    </div>
  </ng-template>

  <div class="shell">
    <!-- palette -->
    <aside class="panel left">
      <h1>Arch Draw</h1>

      <div class="row">
        <input class="in" [(ngModel)]="title" (ngModelChange)="setTitle($event)" placeholder="Diagram title" />
      </div>

      <h2>Add a box</h2>
      <p class="hint">Click a category, then click the canvas.</p>
      <div class="cats">
        @for (c of categories; track c.id) {
          <button class="cat" [class.on]="pending() === c.id"
                  [style.--c]="c.color"
                  (click)="arm(c.id)">
            @if (vectorPath(c.icon); as d) {
              <svg class="vico" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="d" /></svg>
            } @else {
              <span class="ico">{{ c.icon }}</span>
            }
            {{ c.label }}
          </button>
        }
      </div>

      <h2>Containers</h2>
      <p class="hint">Drag a container's header on the canvas to move it and everything in it.</p>
      <button class="btn" (click)="addGroup()">New container</button>
      @if (containers().length) {
        <div class="list">
          @for (g of containers(); track g.id) {
            <div class="li">
              <input class="in tiny" [ngModel]="g.label" (ngModelChange)="patchGroup(g.id, { label: $event })" />
              <button class="x" (click)="removeGroup(g.id)">×</button>
            </div>
          }
        </div>
      }

      <h2>Subnets</h2>
      <p class="hint">Containers too: a subnet encloses the boxes assigned to it.</p>
      <button class="btn" (click)="addSubnet()">New subnet</button>
      @if (subnets().length) {
        <div class="list">
          @for (s of subnets(); track s.id) {
            <div class="li">
              <input class="in tiny" [ngModel]="s.label" (ngModelChange)="patchGroup(s.id, { label: $event })" />
              <input class="in tiny" [ngModel]="s.cidr" (ngModelChange)="patchGroup(s.id, { cidr: $event || undefined })" placeholder="10.0.0.0/24" />
              <button class="x" (click)="removeGroup(s.id)">×</button>
            </div>
          }
        </div>
      }

      <h2>Security groups</h2>
      <button class="btn" (click)="addSecurityGroup()">New security group</button>
      @if (securityGroups().length) {
        <div class="list">
          @for (s of securityGroups(); track s.id) {
            <div class="li">
              <input class="in tiny" [ngModel]="s.name" (ngModelChange)="patchNet(s.id, { name: $event })" />
              <input class="in tiny" [ngModel]="s.note" (ngModelChange)="patchNet(s.id, { note: $event || undefined })" placeholder="443 from ALB" />
              <button class="x" (click)="removeNet(s.id)">×</button>
            </div>
          }
        </div>
      }

      <h2>Layout</h2>
      <div class="seg">
        @for (m of modes; track m) {
          <button class="btn ghost" [class.on]="mode() === m" (click)="mode.set(m)">{{ m }}</button>
        }
      </div>
      <p class="hint">Hand-placed boxes never move, whichever you pick.</p>


      <h2>Flows</h2>
      <p class="hint">A path over the diagram. Say where it starts, then step to a
        neighbour each time — along a link, or into a container.</p>
      <button class="btn" (click)="addFlow()">New flow</button>
      @if (flows().length) {
        <div class="list">
          @for (f of flows(); track f.id) {
            <div class="li">
              <button class="x" [class.on]="flowId() === f.id"
                      (click)="pickFlow(flowId() === f.id ? null : f.id)">{{ flowId() === f.id ? '\u25c9' : '\u25cb' }}</button>
              <input class="in tiny" [ngModel]="f.label"
                     (ngModelChange)="patchFlow(f.id, { label: $event })" />
              <button class="x" (click)="removeFlow(f.id)">\u00d7</button>
            </div>
          }
        </div>
      }

      @if (activeFlow(); as f) {
        <div class="startsat">
          <span class="muted">starts at</span>
          <strong>{{ f.from ? elementName(f.from) : 'nowhere yet' }}</strong>
        </div>
        <button class="btn ghost" [disabled]="!picked()" (click)="setStart()">
          @if (!picked()) { Pick a box or container on the canvas }
          @else if (!f.from) { Start at {{ elementName(picked()!) }} }
          @else { Restart at {{ elementName(picked()!) }} }
        </button>
        @if (f.from && f.steps.length) {
          <p class="hint">Restarting clears the {{ f.steps.length }} hops already drawn.</p>
        }

        @if (f.from) {
          <div class="list">
            @for (h of f.steps; track $index) {
              <div class="li">
                <button class="x" [class.on]="stepIndex() === $index"
                        (click)="gotoStep($index)">{{ $index + 1 }}</button>
                <input class="in tiny" [ngModel]="h.label ?? ''"
                       [placeholder]="elementName(h.to)"
                       (ngModelChange)="patchStep($index, { label: $event || undefined })" />
                @if ($index === f.steps.length - 1) {
                  <button class="x" (click)="removeLastStep()">\u00d7</button>
                }
              </div>
              @if (stepIndex() === $index) {
                <div class="li sub">
                  <input class="in tiny mono" [ngModel]="h.detail ?? ''"
                         placeholder="second line, e.g. the class doing the work"
                         (ngModelChange)="patchStep($index, { detail: $event || undefined })" />
                  <button class="x" (click)="holdLess($index)" title="Shorter">\u2212</button>
                  <span class="muted">{{ h.beats ?? 1 }}\u00d7</span>
                  <button class="x" (click)="holdMore($index)" title="Hold this hop longer">+</button>
                </div>
              }
            }
          </div>

        <label class="f"><span>Pace</span>
          <select class="in" [ngModel]="paceOf(f)" (ngModelChange)="setBeat($event)">
            @for (p of paces; track p.ms) {
              <option [value]="p.ms">{{ p.label }} \u00b7 {{ p.ms }}ms a hop</option>
            }
          </select>
        </label>
        <p class="hint">A slower pace makes a longer, smoother GIF: the capture rate is fixed,
          so each hop gets more frames.</p>

          <p class="hint">From <b>{{ elementName(pathEnd()) }}</b> it can go:</p>
          @if (nextHops().length) {
            <div class="list">
              @for (c of nextHops(); track c.key) {
                <button class="btn ghost hop" (click)="addHop(c)">
                  <span class="hopto">{{ c.label }}</span>
                  <span class="muted">{{ c.how }}</span>
                </button>
              }
            </div>
          } @else {
            <p class="hint">Nothing leads out of here. Draw a link from it, or put it in a container.</p>
          }
          <label class="chk">
            <input type="checkbox" [ngModel]="extendOnClick()"
                   (ngModelChange)="extendOnClick.set($event)" />
            <span>Extend by clicking the canvas</span>
          </label>
        }
      }

      <h2>File</h2>
      <div class="seg">
        <button class="btn ghost" (click)="save()">Save</button>
        <button class="btn ghost" (click)="exportJson()">Export</button>
        <label class="btn ghost file">Import<input type="file" accept="application/json" (change)="importJson($event)" hidden /></label>
      </div>
      <div class="seg">
        <button class="btn ghost" [disabled]="!!capturing()" (click)="exportPng()">Export PNG</button>
      </div>
      <button class="btn ghost danger" (click)="clear()">Start over</button>

      <h2>Animated GIF</h2>
      <label class="f"><span>Resolution</span>
        <select class="in" [ngModel]="quality()" (ngModelChange)="setQuality($event)">
          @for (q of qualities; track q.id) {
            <option [value]="q.id">{{ q.label }}</option>
          }
        </select>
      </label>
      @if (plan(); as p) {
        <p class="hint mono">{{ planText(p) }}</p>
      }
      <button class="btn ghost" [disabled]="!!capturing()" (click)="exportGif()">
        {{ capturing() ?? 'Export animated GIF' }}
      </button>
      <p class="hint">One full loop, timed to repeat seamlessly. With a flow selected that is the
        whole journey, caption and all; otherwise it is one turn of the link animation.</p>
    </aside>

    <!-- canvas -->
    <main class="canvas">
      <div class="bar">
        <span class="t">{{ title() || 'Untitled' }}</span>
        <span class="muted">{{ model().nodes.length }} boxes · {{ model().edges.length }} links</span>
        <span class="grow"></span>
        @if (linking()) {
          <span class="linking">Click the target box or container… <button class="btn ghost" (click)="cancelLink()">cancel</button></span>
        }
        @if (activeFlow(); as f) {
          <span class="player">
            <button class="btn ghost" (click)="togglePlay()">{{ playing() ? '\u2016' : '\u25b6' }}</button>
            <button class="btn ghost" (click)="gotoStep(stepIndex() - 1)">\u2190</button>
            <span class="muted">{{ f.steps.length ? stepIndex() + 1 : 0 }} / {{ f.steps.length }}</span>
            <button class="btn ghost" (click)="gotoStep(stepIndex() + 1)">\u2192</button>
            <button class="btn ghost" (click)="pickFlow(null)">stop</button>
          </span>
        }
        <button class="btn ghost" (click)="diagram.zoom(0.8)">＋</button>
        <button class="btn ghost" (click)="diagram.zoom(1.25)">−</button>
        <button class="btn ghost" (click)="diagram.fit()">Fit</button>
      </div>

      <arch-diagram #diagram
        [model]="model()"
        [mode]="mode()"
        [editable]="true"
        [selectedId]="selectedId()"
        [selectedEdgeId]="selectedEdgeId()"
        [selectedGroupId]="selectedGroupId()"
        [flow]="flowId()"
        [flowPlaying]="playing()"
        (nodeSelected)="onSelect($event)"
        (edgeSelected)="onSelectEdge($event)"
        (groupSelected)="onSelectGroup($event)"
        (groupMoved)="onGroupMoved($event)"
        (nodeMoved)="onMoved($event)"
        (nodeResized)="onResized($event)"
        (canvasClicked)="onCanvas($event)" />
    </main>

    <!-- properties -->
    <aside class="panel right">
      @if (selectedGroup(); as g) {
        <h2>{{ g.kind === 'network' ? 'Subnet' : 'Container' }}</h2>
        <p class="hint">Drag its header to move it and everything inside.</p>
        <label class="f"><span>Name</span>
          <input class="in" [ngModel]="g.label" (ngModelChange)="patchGroup(g.id, { label: $event })" /></label>
        @if (g.kind === 'network') {
          <label class="f"><span>CIDR</span>
            <input class="in mono" [ngModel]="g.cidr" (ngModelChange)="patchGroup(g.id, { cidr: $event || undefined })" placeholder="10.0.1.0/24" /></label>
        }
        <label class="f"><span>Colour</span>
          <select class="in" [ngModel]="g.categoryId ?? ''" (ngModelChange)="patchGroup(g.id, { categoryId: $event || undefined })">
            <option value="">default grey</option>
            @for (c of categories; track c.id) { <option [value]="c.id">{{ c.label }}</option> }
          </select></label>
        <ng-container *ngTemplateOutlet="picker; context: { $implicit: g.icon, kind: 'group', id: g.id, head: 'Icon' }" />
        <label class="f"><span>Inside</span>
          <select class="in" [ngModel]="g.parentId ?? ''" (ngModelChange)="patchGroup(g.id, { parentId: $event || undefined })">
            <option value="">nothing</option>
            @for (p of parentChoices(g.id); track p.id) { <option [value]="p.id">{{ p.label }}</option> }
          </select></label>
        <p class="hint">{{ memberCount(g.id) }} {{ memberCount(g.id) === 1 ? 'box' : 'boxes' }} inside.</p>
        <div class="seg">
          <button class="btn" (click)="startLink(g.id)">Draw link →</button>
          <button class="btn ghost danger" (click)="confirmRemoveGroup(g.id)">Delete</button>
        </div>

        @if (linksOf(g.id).length) {
          <h2>Links</h2>
          <div class="list">
            @for (e of linksOf(g.id); track e.id) {
              <button class="link-row" (click)="selectEdge(e.id)">
                <span class="arrow">{{ e.dir === 'both' ? '↔' : e.from === g.id ? '→' : '←' }}</span>
                {{ nodeName(e.from === g.id ? e.to : e.from) }}
                @if (e.label) { <span class="muted">· {{ e.label }}</span> }
              </button>
            }
          </div>
        }
      }
      @if (selectedEdge(); as e) {
        <h2>Link</h2>
        <p class="hint">{{ nodeName(e.from) }} → {{ nodeName(e.to) }}</p>
        <label class="f"><span>Label</span>
          <input class="in" [ngModel]="e.label" (ngModelChange)="patchEdge(e.id, { label: $event || undefined })" placeholder="PORT 443" /></label>
        <label class="f"><span>Direction</span>
          <select class="in" [ngModel]="e.dir ?? 'one'" (ngModelChange)="patchEdge(e.id, { dir: $event })">
            <option value="one">One way →</option>
            <option value="both">Both ways ↔</option>
          </select></label>
        <label class="f"><span>Style</span>
          <select class="in" [ngModel]="e.kind ?? 'dashed'" (ngModelChange)="patchEdge(e.id, { kind: $event })">
            <option value="dashed">dashed — flowing</option>
            <option value="dotted">dotted — flowing</option>
            <option value="solid">solid — still</option>
          </select></label>
        <label class="f"><span>Route</span>
          <select class="in" [ngModel]="e.route ?? 'auto'" (ngModelChange)="patchEdge(e.id, { route: $event === 'auto' ? undefined : $event })">
            <option value="auto">auto — facing sides</option>
            <option value="side">left and right</option>
            <option value="stack">top and bottom</option>
          </select></label>
        @if (e.kind !== 'solid') {
          <label class="f"><span>Speed</span>
            <select class="in" [ngModel]="e.speed ?? 'normal'" (ngModelChange)="patchEdge(e.id, { speed: $event })">
              @for (s of speeds; track s.id) { <option [value]="s.id">{{ s.label }}</option> }
            </select></label>
        }
        <div class="seg">
          <button class="btn ghost" (click)="flipEdge(e.id)">Reverse ⇄</button>
          <button class="btn ghost danger" (click)="confirmRemoveEdge(e.id)">Delete</button>
        </div>
      }
      @if (selected(); as n) {
        <h2>Box</h2>
        <label class="f"><span>Title</span>
          <input class="in" [ngModel]="n.label" (ngModelChange)="patch(n.id, { label: $event })" /></label>
        <label class="f"><span>Subtitle</span>
          <input class="in" [ngModel]="n.sublabel" (ngModelChange)="patch(n.id, { sublabel: $event })" placeholder="AWS::S3::Bucket" /></label>
        <label class="f"><span>Icon</span>
          <input class="in" [ngModel]="n.icon" (ngModelChange)="patch(n.id, { icon: $event || undefined })" placeholder="leave blank to use the type" /></label>
        <ng-container *ngTemplateOutlet="picker; context: { $implicit: n.icon, kind: 'node', id: n.id, head: 'Pick one' }" />
        <label class="f"><span>Shape</span>
          <select class="in" [ngModel]="effectiveShape(n)" (ngModelChange)="setShape(n.id, $event)">
            <option value="rect">Box</option>
            <option value="cylinder">Cylinder</option>
            <option value="square">Square</option>
            <option value="circle">Circle</option>
            <option value="oval">Oval</option>
            <option value="diamond">Diamond (decision)</option>
          </select></label>
        <label class="f"><span>Category</span>
          <select class="in" [ngModel]="n.categoryId" (ngModelChange)="patch(n.id, { categoryId: $event })">
            @for (c of categories; track c.id) { <option [value]="c.id">{{ c.label }}</option> }
          </select></label>
        <label class="f"><span>Container</span>
          <select class="in" [ngModel]="n.groupId ?? ''" (ngModelChange)="patch(n.id, { groupId: $event || undefined })">
            <option value="">none</option>
            @for (g of containers(); track g.id) { <option [value]="g.id">{{ g.label }}</option> }
          </select></label>

        <h2>Network</h2>
        <label class="f"><span>IP</span>
          <input class="in mono" [ngModel]="n.ip" (ngModelChange)="patch(n.id, { ip: $event || undefined })" placeholder="10.0.2.15" /></label>
        <label class="f"><span>Subnet</span>
          <select class="in" [ngModel]="n.subnetId ?? ''" (ngModelChange)="setSubnet(n.id, $event)">
            <option value="">none</option>
            @for (s of subnets(); track s.id) { <option [value]="s.id">{{ s.label }}{{ s.cidr ? ' · ' + s.cidr : '' }}</option> }
            <option value="__new__">＋ new subnet…</option>
          </select></label>
        <div class="f"><span>Security groups</span>
          @if (nodeSgs(n).length) {
            <div class="chips">
              @for (s of nodeSgs(n); track s.id) {
                <span class="chip">{{ s.name }}<button class="x" (click)="removeSg(n.id, s.id)">×</button></span>
              }
            </div>
          }
          <select class="in" [ngModel]="''" (ngModelChange)="addSg(n.id, $event)">
            <option value="" disabled>add a security group…</option>
            @for (s of availableSgs(n); track s.id) { <option [value]="s.id">{{ s.name }}</option> }
            <option value="__new__">＋ new security group…</option>
          </select></div>
        <label class="f"><span>Notes</span>
          <textarea class="in mono" rows="2" [ngModel]="n.info"
                    (ngModelChange)="patch(n.id, { info: $event || undefined })"
                    placeholder="extra hover lines"></textarea></label>

        <div class="seg">
          <button class="btn" (click)="startLink(n.id)">Draw link →</button>
          <button class="btn ghost danger" (click)="confirmRemoveNode(n.id)">Delete</button>
        </div>

        @if (linksOf(n.id).length) {
          <h2>Links</h2>
          <p class="hint">Click a connector on the canvas to edit it.</p>
          <div class="list">
            @for (e of linksOf(n.id); track e.id) {
              <button class="link-row" (click)="selectEdge(e.id)">
                <span class="arrow">{{ e.dir === 'both' ? '↔' : e.from === n.id ? '→' : '←' }}</span>
                {{ nodeName(e.from === n.id ? e.to : e.from) }}
                @if (e.label) { <span class="muted">· {{ e.label }}</span> }
              </button>
            }
          </div>
        }
      }
      @if (!selected() && !selectedEdge() && !selectedGroup()) {
        <h2>Nothing selected</h2>
        <p class="hint">Pick a category on the left, then click the canvas to drop a box. Click a box to edit it, drag to move it, click a connector to edit the link.</p>
        <h2>Types</h2>
        <p class="hint">A subtitle matching a known resource type picks up its icon automatically.</p>
        <div class="types">
          @for (t of knownTypes; track t) { <button class="type" (click)="applyType(t)">{{ t }}</button> }
        </div>
      }
    </aside>
  </div>
  `,
  styles: [`
    :host { display: block; height: 100vh; background: #0b1220; color: #e6edf7;
            font: 13px ui-sans-serif, system-ui, sans-serif; }
    .shell { display: grid; grid-template-columns: 250px 1fr 280px; height: 100vh; }
    .panel { background: #111a2b; border-right: 1px solid #1e293b; padding: 14px; overflow: auto; }
    .panel.right { border-right: 0; border-left: 1px solid #1e293b; }
    h1 { font-size: 15px; margin: 0 0 14px; letter-spacing: .02em; }
    h2 { font-size: 10px; text-transform: uppercase; letter-spacing: .09em;
         color: #7c8aa5; margin: 18px 0 8px; }
    .hint { color: #7c8aa5; font-size: 11px; margin: 0 0 10px; line-height: 1.5; }
    .row { margin-bottom: 10px; }
    .in { width: 100%; background: #0b1220; border: 1px solid #263449; color: inherit;
          border-radius: 6px; padding: 6px 8px; font: inherit; }
    .in.tiny { padding: 4px 6px; font-size: 11px; }
    .in.dir { width: 44px; flex: none; }
    .in.mono { font: 400 11px ui-monospace, monospace; resize: vertical; }
    .link-row { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left;
                background: #0b1220; border: 1px solid #263449; color: inherit;
                border-radius: 6px; padding: 5px 8px; font: inherit; font-size: 11px; cursor: pointer; }
    .link-row:hover { border-color: #3b82f6; }
    .arrow { color: #7c8aa5; }
    .btn:disabled { opacity: .6; cursor: default; }
    .ico-head { display: flex; align-items: center; justify-content: space-between;
                color: #7c8aa5; font-size: 11px; }
    .ico-group { color: #64748b; font-size: 10px; text-transform: uppercase;
                 letter-spacing: .07em; margin-top: 6px; }
    .glyphs { display: grid; grid-template-columns: repeat(8, 1fr); gap: 3px; }
    .glyph { background: #0b1220; border: 1px solid #263449; border-radius: 5px;
             padding: 3px 0; font-size: 14px; line-height: 1.2; cursor: pointer; }
    .glyph:hover { border-color: #3b82f6; }
    .glyph.on { border-color: #3b82f6; background: #1d283a; }
    .mini { background: transparent; border: 1px solid #263449; color: #93a3bd;
            border-radius: 5px; padding: 1px 6px; font: inherit; font-size: 10px; cursor: pointer; }
    .mini.on { border-color: #3b82f6; color: #e6edf7; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .chip { display: inline-flex; align-items: center; gap: 2px; background: #1d283a;
            border: 1px solid #263449; border-radius: 10px; padding: 2px 4px 2px 9px; font-size: 11px; }
    .f { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
    .f > span { color: #7c8aa5; font-size: 11px; }
    .cats { display: flex; flex-direction: column; gap: 4px; }
    .cat { display: flex; align-items: center; gap: 8px; text-align: left; cursor: pointer;
           background: #0b1220; border: 1px solid #263449; border-left: 3px solid var(--c);
           color: inherit; border-radius: 6px; padding: 6px 8px; font: inherit; }
    .cat:hover { border-color: var(--c); }
    .cat.on { background: color-mix(in srgb, var(--c) 18%, #0b1220); border-color: var(--c); }
    .ico { font-size: 14px; }
    .vico { width: 15px; height: 15px; flex: none; fill: none; stroke: currentColor;
            stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    .btn { background: #2563eb; border: 0; color: #fff; border-radius: 6px;
           padding: 7px 10px; cursor: pointer; font: inherit; }
    .btn.ghost { background: transparent; border: 1px solid #263449; color: inherit; }
    .btn.ghost.on { background: #1d283a; border-color: #3b82f6; }
    .btn.danger { border-color: #7f1d1d; color: #f87171; }
    .btn.file { display: inline-block; text-align: center; }
    .seg { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
    .list { display: flex; flex-direction: column; gap: 5px; }
    .li { display: flex; gap: 5px; align-items: center; }
    .x { background: none; border: 0; color: #64748b; cursor: pointer; font-size: 15px; }
    .x.on { color: #fbbf24; }
    .li.sub { padding-left: 20px; }
    .player { display: flex; gap: 4px; align-items: center; }
    .startsat { display: flex; gap: 6px; align-items: baseline; margin: 8px 0 6px; }
    .startsat .muted { text-transform: uppercase; letter-spacing: .08em; font-size: 9px; }
    .startsat strong { color: #e6edf7; font-size: 12px; }
    .hop { display: flex; justify-content: space-between; gap: 10px; text-align: left; width: 100%; }
    .hopto { color: #e6edf7; }
    .chk { display: flex; gap: 6px; align-items: center; color: #7c8aa5; font-size: 11px; margin-top: 8px; }
    .x:hover { color: #f87171; }
    .canvas { display: flex; flex-direction: column; min-width: 0; }
    .bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px;
           border-bottom: 1px solid #1e293b; background: #111a2b; }
    .t { font-weight: 600; }
    .muted { color: #7c8aa5; font-size: 11px; }
    .grow { flex: 1; }
    .linking { color: #fbbf24; font-size: 11px; display: flex; align-items: center; gap: 6px; }
    arch-diagram { flex: 1; min-height: 0; }
    .types { display: flex; flex-wrap: wrap; gap: 4px; }
    .type { background: #0b1220; border: 1px solid #263449; color: #93a3bd;
            border-radius: 5px; padding: 3px 6px; font: 400 10px ui-monospace, monospace; cursor: pointer; }
    .type:hover { border-color: #3b82f6; color: #e6edf7; }
  `],
})
export class AppComponent {
  @ViewChild('diagram') diagram!: ArchDiagramComponent;

  readonly categories = DEFAULT_CATEGORIES;
  readonly modes: LayoutMode[] = ['manual', 'layered', 'force'];
  readonly knownTypes = Object.keys(DEFAULT_TYPE_ICONS);
  readonly iconLibrary = ICON_LIBRARY;

  /** Drawn icons render as a path here too, not just on the canvas. */
  vectorPath(icon: string | undefined): string | null { return vectorIconPath(icon); }

  /** What a box is actually drawn as, which its family may be deciding. */
  effectiveShape(n: DiagramNode): NodeShape {
    return n.shape ?? this.categories.find((c) => c.id === n.categoryId)?.shape ?? 'rect';
  }

  /** The picker serves boxes and containers alike; this is where they differ. */
  setIcon(kind: 'node' | 'group', id: string, icon: string | undefined): void {
    if (kind === 'node') this.patch(id, { icon });
    else this.patchGroup(id, { icon });
  }
  readonly speeds: { id: EdgeSpeed; label: string }[] = [
    { id: 'slow', label: 'Slow' },
    { id: 'normal', label: 'Normal' },
    { id: 'fast', label: 'Fast' },
    { id: 'turbo', label: 'Very fast' },
  ];

  model = signal<DiagramModel>(this.restore());
  mode = signal<LayoutMode>('manual');
  title = signal(this.model().title ?? '');
  selectedId = signal<string | null>(null);
  selectedEdgeId = signal<string | null>(null);
  selectedGroupId = signal<string | null>(null);
  /** Progress text while a GIF is being rendered, or null when idle. */
  capturing = signal<string | null>(null);

  /** The category armed for the next canvas click. */
  pending = signal<string | null>(null);
  /** The node a link is being drawn from. */
  linking = signal<string | null>(null);

  /** The flow on show, whether its clock runs, and whether clicks extend it. */
  flowId = signal<string | null>(null);
  playing = signal(false);
  extendOnClick = signal(false);

  selected = computed(() => this.model().nodes.find((n) => n.id === this.selectedId()) ?? null);
  selectedEdge = computed(() => this.model().edges.find((e) => e.id === this.selectedEdgeId()) ?? null);
  selectedGroup = computed(() => this.model().groups.find((g) => g.id === this.selectedGroupId()) ?? null);
  groups = computed(() => this.model().groups);
  containers = computed(() => this.model().groups.filter((g) => g.kind !== 'network'));
  subnets = computed(() => this.model().groups.filter((g) => g.kind === 'network'));
  securityGroups = computed(() => this.model().net ?? []);
  flows = computed(() => this.model().flows ?? []);
  activeFlow = computed(() => this.flows().find((f) => f.id === this.flowId()) ?? null);

  constructor() {
    void this.openFromLink();
    this.refreshPlan();
  }

  /**
   * A diagram, and a place in it, named in the address.
   *
   * <p><code>?diagram=&lt;url&gt;</code> opens one instead of whatever this
   * browser was last working on, <code>&flow=&lt;id&gt;</code> plays a flow in
   * it, and <code>&step=&lt;n&gt;</code> holds on one hop rather than playing
   * — which is what makes it possible to send somebody a link to the moment
   * Kafka hands the order over, rather than to the whole picture.</p>
   *
   * <p>A diagram opened this way is not saved over the one already here. It
   * becomes this browser's copy only once something is edited.</p>
   */
  private async openFromLink(): Promise<void> {
    const query = new URLSearchParams(location.search);
    const source = query.get('diagram');
    const flow = query.get('flow');
    const step = query.get('step');
    if (!source && !flow) return;

    if (source) {
      try {
        const loaded = (await (await fetch(source)).json()) as DiagramModel;
        this.model.set(this.normalize(loaded));
        this.title.set(loaded.title ?? '');
      } catch {
        alert(`Could not open ${source}`);
        return;
      }
    }

    // Three passes, because each waits on the one before: the canvas has to
    // exist, then it has to learn which flow it is showing, and only then can
    // it be framed around the caption and wound to a hop.
    setTimeout(() => {
      if (flow) this.pickFlow(flow);
      setTimeout(() => {
        this.diagram?.fit();
        if (flow && step != null) this.gotoStep(Number(step) - 1);
      });
    });
  }

  // ---- palette ----

  arm(categoryId: string): void {
    this.pending.set(this.pending() === categoryId ? null : categoryId);
  }

  onCanvas(at: { x: number; y: number }): void {
    const categoryId = this.pending();
    if (!categoryId) return;

    const category = this.categories.find((c) => c.id === categoryId)!;
    // The shape is left off: the family supplies it, so the box follows the
    // family rather than being frozen as whatever it was when it was drawn.
    const node: DiagramNode = {
      id: id('n'),
      label: category.label,
      categoryId,
      x: Math.round(at.x - 95),
      y: Math.round(at.y - 23),
    };

    this.update((m) => ({ ...m, nodes: [...m.nodes, node] }));
    this.selectedId.set(node.id);
    this.pending.set(null);
  }

  // ---- selection, movement, linking ----

  onSelect(nodeId: string | null): void {
    const from = this.linking();
    if (from && nodeId && nodeId !== from) {
      this.addEdge(from, nodeId);
      this.linking.set(null);
      return;
    }
    if (this.tryExtend(nodeId)) return;
    this.selectedId.set(nodeId);
  }

  // The canvas reports all three on every selection, so each handler only
  // owns its own — no guessing at what order they arrive in.
  onSelectEdge(edgeId: string | null): void { this.selectedEdgeId.set(edgeId); }

  onSelectGroup(groupId: string | null): void {
    // A link may end on a container just as well as on a box.
    const from = this.linking();
    if (from && groupId && groupId !== from) {
      this.addEdge(from, groupId);
      this.linking.set(null);
      return;
    }
    if (this.tryExtend(groupId)) return;
    this.selectedGroupId.set(groupId);
  }

  /** Selecting from a panel list, where no canvas event has cleared the rest. */
  selectEdge(edgeId: string): void {
    this.selectedId.set(null);
    this.selectedGroupId.set(null);
    this.selectedEdgeId.set(edgeId);
  }

  /**
   * Dragging a container carries everything it holds, so the box keeps
   * hugging its contents — it just does so somewhere else. Members are the
   * nodes assigned to it or to any container nested inside it, plus any
   * hand-placed geometry along the way.
   */
  onGroupMoved(move: { id: string; dx: number; dy: number }): void {
    const family = this.groupFamily(move.id);
    const members = new Set(
      this.model().nodes
        .filter((n) => (n.groupId && family.has(n.groupId)) || (n.subnetId && family.has(n.subnetId)))
        .map((n) => n.id),
    );

    this.update((m) => ({
      ...m,
      nodes: m.nodes.map((n) => (members.has(n.id)
        ? { ...n, x: (n.x ?? 0) + move.dx, y: (n.y ?? 0) + move.dy }
        : n)),
      groups: m.groups.map((g) => (family.has(g.id) && g.x != null && g.y != null
        ? { ...g, x: g.x + move.dx, y: g.y + move.dy }
        : g)),
    }));
  }

  /** A container and every container nested inside it. */
  private groupFamily(groupId: string): Set<string> {
    const groups = this.model().groups;
    const family = new Set([groupId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const g of groups) {
        if (g.parentId && family.has(g.parentId) && !family.has(g.id)) {
          family.add(g.id);
          grew = true;
        }
      }
    }
    return family;
  }

  confirmRemoveGroup(groupId: string): void {
    const g = this.model().groups.find((x) => x.id === groupId);
    if (!g) return;
    if (!confirm(`Delete the container "${g.label}"? The boxes inside it stay.`)) return;
    this.removeGroup(groupId);
    this.selectedGroupId.set(null);
  }

  /** Containers this one may sit inside: anything but itself or its own descendants. */
  parentChoices(groupId: string): DiagramGroup[] {
    const family = this.groupFamily(groupId);
    return this.model().groups.filter((g) => !family.has(g.id));
  }

  /** A link end is a box or a container, so look in both. */
  nodeName(endpointId: string): string {
    const m = this.model();
    return m.nodes.find((n) => n.id === endpointId)?.label
      ?? m.groups.find((g) => g.id === endpointId)?.label
      ?? '?';
  }

  memberCount(groupId: string): number {
    const family = this.groupFamily(groupId);
    return this.model().nodes.filter(
      (n) => (n.groupId && family.has(n.groupId)) || (n.subnetId && family.has(n.subnetId)),
    ).length;
  }

  /** Swaps the ends, which is usually what "wrong way round" needs. */
  flipEdge(edgeId: string): void {
    const e = this.model().edges.find((x) => x.id === edgeId);
    if (e) this.patchEdge(edgeId, { from: e.to, to: e.from });
  }

  confirmRemoveEdge(edgeId: string): void {
    const e = this.model().edges.find((x) => x.id === edgeId);
    if (!e) return;
    if (!confirm(`Delete the link ${this.nodeName(e.from)} → ${this.nodeName(e.to)}?`)) return;
    this.removeEdge(edgeId);
    this.selectedEdgeId.set(null);
  }

  /**
   * Dragging is what makes a node hand-placed: it gains coordinates, and no
   * layout will move it again.
   */
  onMoved(move: { id: string; x: number; y: number }): void {
    this.update((m) => ({
      ...m,
      nodes: m.nodes.map((n) => (n.id === move.id ? { ...n, x: move.x, y: move.y } : n)),
    }));
  }

  /** A drag on the corner handle sizes the node by hand, like dragging places it. */
  onResized(size: { id: string; width: number; height: number }): void {
    this.patch(size.id, { width: size.width, height: size.height });
  }

  /**
   * Switching to a square or circle folds any hand-set width/height into one
   * side, so the node does not jump between two remembered sizes.
   */
  setShape(nodeId: string, shape: NodeShape): void {
    this.update((m) => ({
      ...m,
      nodes: m.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        // Stored even when it is `rect`, since leaving it off would hand the
        // choice back to the family — which is not what picking Box means.
        const next: DiagramNode = { ...n, shape };
        if ((shape === 'square' || shape === 'circle') && (n.width != null || n.height != null)) {
          next.width = next.height = Math.max(n.width ?? 0, n.height ?? 0);
        }
        return next;
      }),
    }));
  }

  startLink(fromId: string): void { this.linking.set(fromId); }
  cancelLink(): void { this.linking.set(null); }

  private addEdge(from: string, to: string): void {
    const edge: DiagramEdge = { id: id('e'), from, to, kind: 'dashed' };
    this.update((m) => ({ ...m, edges: [...m.edges, edge] }));
  }

  linksOf(nodeId: string): DiagramEdge[] {
    return this.model().edges.filter((e) => e.from === nodeId || e.to === nodeId);
  }

  // ---- edits ----

  patch(nodeId: string, changes: Partial<DiagramNode>): void {
    this.update((m) => ({
      ...m,
      nodes: m.nodes.map((n) => (n.id === nodeId ? { ...n, ...changes } : n)),
    }));
  }

  patchEdge(edgeId: string, changes: Partial<DiagramEdge>): void {
    this.update((m) => ({
      ...m,
      edges: m.edges.map((e) => (e.id === edgeId ? { ...e, ...changes } : e)),
    }));
  }

  /** The Delete key removes whatever is selected — but never while typing. */
  @HostListener('window:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (event.key !== 'Delete') return;
    const tag = (event.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const e = this.selectedEdge();
    if (e) { this.confirmRemoveEdge(e.id); return; }
    const g = this.selectedGroup();
    if (g) { this.confirmRemoveGroup(g.id); return; }
    const n = this.selected();
    if (n) this.confirmRemoveNode(n.id);
  }

  confirmRemoveNode(nodeId: string): void {
    const n = this.model().nodes.find((x) => x.id === nodeId);
    if (!n) return;
    if (!confirm(`Delete "${n.label}" and its links?`)) return;
    this.removeNode(nodeId);
  }

  removeNode(nodeId: string): void {
    this.update((m) => ({
      ...m,
      nodes: m.nodes.filter((n) => n.id !== nodeId),
      edges: m.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
    }));
    this.selectedId.set(null);
  }

  removeEdge(edgeId: string): void {
    this.update((m) => ({ ...m, edges: m.edges.filter((e) => e.id !== edgeId) }));
  }

  applyType(type: string): void {
    const n = this.selected();
    if (n) this.patch(n.id, { type, sublabel: type });
  }

  // ---- shared network entities ----

  /** Creates a pool security group with a workable name; rename it in the left panel. */
  addSecurityGroup(): NetEntity {
    const entity: NetEntity = {
      id: id('sg'),
      kind: 'securityGroup',
      name: `sg-${(this.model().net ?? []).length + 1}`,
    };
    this.update((m) => ({ ...m, net: [...(m.net ?? []), entity] }));
    return entity;
  }

  /** A subnet is a network-kind group: a container with a CIDR and an icon. */
  addSubnet(): DiagramGroup {
    const group: DiagramGroup = {
      id: id('sn'),
      label: `subnet-${this.subnets().length + 1}`,
      kind: 'network',
      categoryId: 'net',
    };
    this.update((m) => ({ ...m, groups: [...m.groups, group] }));
    return group;
  }

  patchNet(entityId: string, changes: Partial<NetEntity>): void {
    this.update((m) => ({
      ...m,
      net: (m.net ?? []).map((e) => (e.id === entityId ? { ...e, ...changes } : e)),
    }));
  }

  /** Deleting from the pool also detaches it from every node that used it. */
  removeNet(entityId: string): void {
    this.update((m) => ({
      ...m,
      net: (m.net ?? []).filter((e) => e.id !== entityId),
      nodes: m.nodes.map((n) => ({
        ...n,
        securityGroupIds: n.securityGroupIds?.filter((s) => s !== entityId),
      })),
    }));
  }

  setSubnet(nodeId: string, value: string): void {
    const subnetId = value === '__new__' ? this.addSubnet().id : value || undefined;
    this.patch(nodeId, { subnetId });
  }

  addSg(nodeId: string, value: string): void {
    if (!value) return;
    const sgId = value === '__new__' ? this.addSecurityGroup().id : value;
    const n = this.model().nodes.find((x) => x.id === nodeId);
    if (!n || n.securityGroupIds?.includes(sgId)) return;
    this.patch(nodeId, { securityGroupIds: [...(n.securityGroupIds ?? []), sgId] });
  }

  removeSg(nodeId: string, sgId: string): void {
    const n = this.model().nodes.find((x) => x.id === nodeId);
    if (!n) return;
    const rest = (n.securityGroupIds ?? []).filter((s) => s !== sgId);
    this.patch(nodeId, { securityGroupIds: rest.length ? rest : undefined });
  }

  nodeSgs(n: DiagramNode): NetEntity[] {
    const pool = this.model().net ?? [];
    return (n.securityGroupIds ?? [])
      .map((sgId) => pool.find((e) => e.id === sgId))
      .filter((e): e is NetEntity => !!e);
  }

  availableSgs(n: DiagramNode): NetEntity[] {
    const used = new Set(n.securityGroupIds ?? []);
    return this.securityGroups().filter((s) => !used.has(s.id));
  }

  // ---- containers ----

  addGroup(): void {
    const group: DiagramGroup = { id: id('g'), label: 'New container' };
    this.update((m) => ({ ...m, groups: [...m.groups, group] }));
  }

  patchGroup(groupId: string, changes: Partial<DiagramGroup>): void {
    this.update((m) => ({
      ...m,
      groups: m.groups.map((g) => (g.id === groupId ? { ...g, ...changes } : g)),
    }));
  }

  /** Works for containers and subnets alike; nodes lose whichever reference. */
  removeGroup(groupId: string): void {
    this.update((m) => ({
      ...m,
      groups: m.groups
        .filter((g) => g.id !== groupId)
        .map((g) => (g.parentId === groupId ? { ...g, parentId: undefined } : g)),
      nodes: m.nodes.map((n) => ({
        ...n,
        groupId: n.groupId === groupId ? undefined : n.groupId,
        subnetId: n.subnetId === groupId ? undefined : n.subnetId,
      })),
      // A link anchored to the container has nothing left to point at.
      edges: m.edges.filter((e) => e.from !== groupId && e.to !== groupId),
    }));
  }

  setTitle(value: string): void {
    this.title.set(value);
    this.update((m) => ({ ...m, title: value }));
  }


  // ---- flows ----

  /** Whatever is selected on the canvas, box or container. */
  picked = computed(() => this.selectedId() ?? this.selectedGroupId());

  /** Where the path currently ends, which is where the next hop starts. */
  pathEnd = computed(() => {
    const flow = this.activeFlow();
    if (!flow) return '';
    return flow.steps.length ? flow.steps[flow.steps.length - 1].to : flow.from;
  });

  /**
   * Everywhere the path can go from where it stands: along any link that
   * touches it in either direction, into anything a container holds, and back
   * out to whatever holds it.
   */
  nextHops = computed(() => {
    const m = this.model();
    const at = this.pathEnd();
    if (!at) return [];

    const out: { key: string; to: string; edgeId?: string; label: string; how: string }[] = [];
    const seen = new Set<string>();
    const add = (to: string, how: string, edgeId?: string) => {
      const key = `${edgeId ?? 'in'}:${to}`;
      if (to === at || seen.has(key)) return;
      seen.add(key);
      out.push({ key, to, edgeId, label: this.elementName(to), how });
    };

    for (const e of m.edges) {
      if (e.from === at) add(e.to, e.label ?? 'along the link', e.id);
      else if (e.to === at) add(e.from, (e.label ?? 'along the link') + ', backwards', e.id);
    }
    for (const n of m.nodes) if (n.groupId === at || n.subnetId === at) add(n.id, 'inside');
    for (const g of m.groups) if (g.parentId === at) add(g.id, 'inside');

    const node = m.nodes.find((n) => n.id === at);
    const group = m.groups.find((g) => g.id === at);
    for (const holder of [node?.subnetId, node?.groupId, group?.parentId]) {
      if (holder) add(holder, 'out to');
    }
    return out;
  });

  /** Selects a flow and plays it. Null stops, handing back hover highlighting. */
  pickFlow(flowId: string | null): void {
    this.flowId.set(flowId);
    this.playing.set(!!flowId);
    this.refreshPlan();
  }

  togglePlay(): void { this.playing.update((on) => !on); }

  /** Jumps to one hop and holds there, since stepping is for looking closely. */
  gotoStep(index: number): void {
    const flow = this.activeFlow();
    if (!flow?.steps.length) return;
    this.playing.set(false);
    this.diagram.seekStep((index + flow.steps.length) % flow.steps.length);
  }

  stepIndex(): number { return this.diagram?.frame()?.index ?? 0; }

  flowSeconds(): string { return ((this.diagram?.flowLoopMs() ?? 0) / 1000).toFixed(1); }

  elementName(id: string): string {
    if (!id) return 'nothing';
    return this.model().nodes.find((n) => n.id === id)?.label
      ?? this.model().groups.find((g) => g.id === id)?.label
      ?? id;
  }

  addFlow(): void {
    const flow: DiagramFlow = {
      id: id('fl'), label: 'New flow', from: this.picked() ?? '', steps: [],
    };
    this.update((m) => ({ ...m, flows: [...(m.flows ?? []), flow] }));
    this.pickFlow(flow.id);
  }

  /** Moves the start. A path built from the old one no longer holds, so it goes. */
  setStart(): void {
    const flow = this.activeFlow();
    const from = this.picked();
    if (!flow || !from) return;
    this.patchFlow(flow.id, { from, steps: [] });
  }

  patchFlow(flowId: string, changes: Partial<DiagramFlow>): void {
    this.update((m) => ({
      ...m,
      flows: (m.flows ?? []).map((f) => (f.id === flowId ? { ...f, ...changes } : f)),
    }));
  }

  removeFlow(flowId: string): void {
    if (this.flowId() === flowId) this.pickFlow(null);
    this.update((m) => ({ ...m, flows: (m.flows ?? []).filter((f) => f.id !== flowId) }));
  }

  addHop(hop: { to: string; edgeId?: string }): void {
    const flow = this.activeFlow();
    if (!flow) return;
    this.patchFlow(flow.id, {
      steps: [...flow.steps, { to: hop.to, edgeId: hop.edgeId }],
    });
  }

  patchStep(index: number, changes: Partial<FlowStep>): void {
    const flow = this.activeFlow();
    if (!flow) return;
    this.patchFlow(flow.id, {
      steps: flow.steps.map((s, i) => (i === index ? { ...s, ...changes } : s)),
    });
  }

  /** Only the last one: dropping a hop from the middle would break the path. */
  removeLastStep(): void {
    const flow = this.activeFlow();
    if (!flow?.steps.length) return;
    this.patchFlow(flow.id, { steps: flow.steps.slice(0, -1) });
  }

  /**
   * Extends the path by clicking, when the click lands somewhere the path can
   * actually reach. Anything else is an ordinary selection.
   */
  private tryExtend(elementId: string | null): boolean {
    if (!elementId || !this.extendOnClick() || !this.activeFlow()?.from) return false;
    const hop = this.nextHops().find((c) => c.to === elementId);
    if (!hop) return false;
    this.addHop(hop);
    return true;
  }


  // ---- pace and picture size ----

  paces = FLOW_PACES;

  /**
   * How big a picture each setting draws.
   *
   * <p>A width and a ceiling on one frame, deliberately not a budget spread
   * over the loop: that made a flow slowed down for readability come out
   * smaller than the same flow at speed, which is the opposite of what anyone
   * slowing it down is asking for. Length costs file size now, not sharpness,
   * and the estimate below says so before the button is pressed. The loop-wide
   * budget stays only as a stop against something pathological.</p>
   */
  qualities: { id: string; label: string; options: CaptureOptions }[] = [
    { id: 'standard', label: 'Standard', options: { maxWidth: 1400, maxFramePixels: 2.4e6, pixelBudget: 2e9 } },
    { id: 'high', label: 'High', options: { maxWidth: 2000, maxFramePixels: 4.6e6, pixelBudget: 2e9 } },
    { id: 'max', label: 'Maximum', options: { maxWidth: 2800, maxFramePixels: 8.8e6, pixelBudget: 2e9 } },
  ];

  quality = signal('standard');

  /** What the next export would come out as, or null before it is known. */
  plan = signal<CapturePlan | null>(null);
  private planTimer: ReturnType<typeof setTimeout> | null = null;

  paceOf(flow: DiagramFlow): string {
    return String(flow.beatMs ?? 600);
  }

  setBeat(value: string): void {
    const flow = this.activeFlow();
    if (flow) this.patchFlow(flow.id, { beatMs: Number(value) });
  }

  setQuality(id: string): void {
    this.quality.set(id);
    this.refreshPlan();
  }

  /** Holds one hop longer, for a step that deserves a moment to read. */
  holdMore(index: number): void { this.setHold(index, 1); }
  holdLess(index: number): void { this.setHold(index, -1); }

  private setHold(index: number, by: number): void {
    const flow = this.activeFlow();
    if (!flow) return;
    const beats = Math.max(1, Math.min(8, (flow.steps[index]?.beats ?? 1) + by));
    this.patchStep(index, { beats: beats === 1 ? undefined : beats });
  }

  private captureOptions(): CaptureOptions {
    return (this.qualities.find((q) => q.id === this.quality()) ?? this.qualities[0]).options;
  }

  /**
   * Works out what the next GIF would be.
   *
   * <p>Coalesced behind a short timer: it measures the drawing, and every drag
   * step is an edit, so asking on each one would measure hundreds of times for
   * one answer.</p>
   */
  refreshPlan(): void {
    if (this.planTimer) clearTimeout(this.planTimer);
    this.planTimer = setTimeout(() => {
      this.planTimer = null;
      try {
        this.plan.set(this.diagram ? this.diagram.capturePlan(this.captureOptions()) : null);
      } catch {
        this.plan.set(null);
      }
    }, 220);
  }

  planText(p: CapturePlan): string {
    const mb = p.bytes / 1048576;
    const size = mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
    return `${p.frames} frames \u00b7 ${p.width}\u00d7${p.height} \u00b7 `
      + `${(p.loopMs / 1000).toFixed(1)}s loop \u00b7 about ${size} MB`
      + (mb > 20 ? ' \u00b7 large to send anywhere' : '');
  }

  // ---- persistence ----

  private update(fn: (m: DiagramModel) => DiagramModel): void {
    const next = fn(this.model());
    this.model.set(next);
    this.save(true);
    this.refreshPlan();
  }

  save(quiet = false): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.model()));
    } catch {
      if (!quiet) alert('Could not save to this browser.');
    }
  }

  private restore(): DiagramModel {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return this.normalize(JSON.parse(raw) as DiagramModel);
    } catch { /* fall through to a blank one */ }
    return emptyDiagram('My architecture');
  }

  /**
   * Subnets briefly lived in the `net` pool before becoming network-kind
   * groups; a diagram saved then converts on load, keeping its ids so node
   * references survive.
   */
  private normalize(m: DiagramModel): DiagramModel {
    // Whether the palette is missing or simply older than the library's, the
    // library's families are the ones to draw with.
    m = withDefaultCategories(m);
    const pool = (m.net ?? []) as { id: string; kind: string; name: string; cidr?: string }[];
    const oldSubnets = pool.filter((e) => e.kind === 'subnet');
    if (!oldSubnets.length) return m;
    return {
      ...m,
      groups: [
        ...(m.groups ?? []),
        ...oldSubnets.map((s) => ({
          id: s.id, label: s.name, kind: 'network' as const, cidr: s.cidr, categoryId: 'net',
        })),
      ],
      net: (m.net ?? []).filter((e) => (e.kind as string) !== 'subnet'),
    };
  }

  exportJson(): void {
    this.download(
      new Blob([JSON.stringify(this.model(), null, 2)], { type: 'application/json' }),
      'json',
    );
  }

  /**
   * Writes the diagram as an animated GIF.
   *
   * <p>The renderer hands back exactly one animation loop as still frames, so
   * the last frame leads back into the first and the GIF repeats without a
   * visible jump. One palette is built from the opening frame and reused for
   * the rest: only the dashes move, so the colours never change, and sharing
   * the palette keeps both the file small and the picture from shimmering.</p>
   */
  async exportGif(): Promise<void> {
    if (this.capturing()) return;
    if (!this.model().nodes.length) { alert('Draw something first.'); return; }

    this.capturing.set('Rendering…');
    try {
      const gif = GIFEncoder();
      const total = Math.max(1, this.diagram.loopMs() / 50);
      let palette: number[][] | null = null;
      let written = 0;

      // The first frames are held back so the palette can be drawn from
      // several of them at once. One frame's worth of colours misses the
      // shades that only appear once the dashes have moved, and a colour the
      // palette lacks is approximated for the whole loop. How many are held
      // depends on how big they are — at export resolutions a frame runs to
      // tens of megabytes, so the count is set once the first one arrives.
      const held: { rgba: Uint8Array; width: number; height: number }[] = [];
      let seed = 0;

      const write = (rgba: Uint8Array, width: number, height: number) => {
        gif.writeFrame(applyPalette(rgba, palette!), width, height, {
          palette: written === 0 ? palette! : undefined,
          delay: 50,
        });
        written++;
      };

      const flush = () => {
        palette = quantize(samplePixels(held.map((f) => f.rgba)), 256);
        for (const f of held) write(f.rgba, f.width, f.height);
        held.length = 0;
      };

      // A journey of a dozen hops is a hundred frames, so the whole capture is
      // budgeted rather than each frame: big enough to read, small enough to
      // send to somebody.
      const meta = await this.diagram.captureLoop((pixels, width, height, index) => {
        const rgba = new Uint8Array(pixels.buffer.slice(0));
        if (palette) {
          write(rgba, width, height);
        } else {
          seed ||= Math.min(
            8,
            Math.round(total) || 1,
            Math.max(1, Math.floor(HELD_FRAME_BYTES / rgba.byteLength)),
          );
          held.push({ rgba, width, height });
          if (held.length >= seed) flush();
        }
        this.capturing.set(`Rendering… ${Math.round(((index + 1) / total) * 100)}%`);
      }, this.captureOptions());
      if (held.length) flush();     // a loop shorter than the seed

      gif.finish();
      this.download(new Blob([gif.bytes()], { type: 'image/gif' }), 'gif');
      console.info(
        `arch-draw: ${meta.frames} frames, ${meta.width}×${meta.height}, ` +
        `${meta.delayMs}ms each — a ${(meta.loopMs / 1000).toFixed(1)}s loop`,
      );
    } catch (err) {
      alert(`Could not make a GIF: ${(err as Error).message}`);
    } finally {
      this.capturing.set(null);
    }
  }

  /** A still at three device pixels per diagram unit, so it stays sharp. */
  async exportPng(): Promise<void> {
    if (this.capturing()) return;
    this.capturing.set('Rendering…');
    try {
      this.download(await this.diagram.renderStill(3), 'png');
    } catch (err) {
      alert(`Could not make a PNG: ${(err as Error).message}`);
    } finally {
      this.capturing.set(null);
    }
  }

  private download(blob: Blob, extension: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(this.title() || 'diagram').replace(/\s+/g, '-').toLowerCase()}.${extension}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  importJson(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as DiagramModel;
        parsed.groups ??= [];
        parsed.edges ??= [];
        parsed.net ??= [];
        this.model.set(this.normalize(parsed));
        this.title.set(parsed.title ?? '');
        this.save(true);
      } catch {
        alert('That file is not a diagram.');
      }
    });
  }

  clear(): void {
    if (!confirm('Discard this diagram and start over?')) return;
    this.model.set(emptyDiagram('My architecture'));
    this.title.set('My architecture');
    this.selectedId.set(null);
    this.save(true);
  }
}
