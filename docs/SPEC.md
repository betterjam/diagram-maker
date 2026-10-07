# Arch Draw — one diagram library, two producers

**Status:** working foundation. The library builds, the editor runs, a diagram can be drawn, saved, exported and re-imported. The infra panel has not adopted it yet.

## The idea worth keeping

A generated diagram and a hand-drawn one differ in exactly **one** thing: whether a node carries its own coordinates.

- `x`/`y` present → a person put it there. No layout will move it, ever.
- `x`/`y` absent → work it out.

Everything else — icons, categories, containers, edges, colours — is identical. That is why one model and one renderer can serve both, and why there is only one thing to maintain.

It also means the two modes mix. Scan AWS, let the layout place 40 boxes, drag the six that matter into place, save. Re-scan next week and those six stay where you put them while new resources flow into the gaps.

## Layout

```
projects/arch-diagram/     the library — the only thing both apps depend on
  src/lib/
    diagram-model.ts       types, default palette, default type→icon map
    diagram-layout.ts      manual | layered | force, plus container fitting
    arch-diagram.component.ts   the <arch-diagram> renderer
src/app/app.component.ts   the manual editor (this app is just a host for it)
```

## The model

```ts
interface DiagramModel {
  title?: string;
  categories: DiagramCategory[];   // colour + icon + label
  groups: DiagramGroup[];          // dashed containers, may nest via parentId; kind 'network' = subnet
  nodes: DiagramNode[];            // x/y optional — that is the whole trick
  edges: DiagramEdge[];            // from, to, label, solid|dashed|dotted
  net?: NetEntity[];               // shared security groups, referenced by id
  flows?: DiagramFlow[];           // ordered journeys over those edges
}
```

`DEFAULT_CATEGORIES` and `DEFAULT_TYPE_ICONS` are lifted verbatim from the infra panel's `architecture.component.ts`, so a diagram exported from there keeps its colours and glyphs when opened in the editor.

A model carries its own copy of the categories so it can travel — open it anywhere and the colours come with it. The cost is that the copy is a snapshot, so a diagram saved last month has last month's families and never learns what the library has since worked out, like the shape a database is drawn as. `withDefaultCategories()` settles it on load: families the library knows are taken from the library, which owns them, and families it does not know are left alone, since those came from somewhere else. Without it a change to a family only ever reaches diagrams drawn after it, which looks exactly like the change not working. Both have since gained a commerce half — point of sale, kiosks, devices, orders, catalog, kitchen, customers as families, and `POS::Terminal`, `KDS::Display`, `Device::Printer` and their like as types. It is appended rather than mixed in: every id the infra panel already writes keeps the exact colour it had.

`ICON_LIBRARY` is the glyph picker's contents, grouped the way someone would look for them — devices, selling, kitchen and service, customer, operations, systems. The hardware on the counter is a group of its own, since a diagram of a shop is half made of it.

Not everything has an emoji worth using. A self-service kiosk has none at all, and a database has one that reads as furniture rather than storage, so `VECTOR_ICONS` holds drawn ones, referenced as `@name` — `@kiosk` and `@database` today. Engines that have a mascot everyone knows keep it: PostgreSQL's elephant, MySQL's dolphin, SQLite's feather. The prefix keeps an icon a plain string, so the model stays JSON and anything that does not recognise it simply prints the name. A drawn icon is a path in a 24×24 box, scaled to the same size the font renders at and centred where the typed glyph's middle would have been, so the two are interchangeable wherever an icon appears: on the canvas, in the palette, in the picker, and in an export. It is stroked in the node's own colour rather than coloured in, which is why it sits with the box instead of on top of it — and why adding another is a path string and nothing else.

Containers nest to any depth — a merchant site holding an application holding its database — and are fitted innermost first, so a parent sizes itself around finished children. Depth counts the whole chain above a container rather than its immediate wrappers: counting wrappers alone ties a grandchild with its parent (each has exactly one), and a tie lets the parent be sized before the box it contains, which leaves the child hanging outside it.

Containers take an icon from the same library, drawn in their label band and in their own colour; a network falls back to `▦` when it has none. The editor offers one picker template to whichever is selected, so a box and a container are choosing from the same list rather than from two that could drift apart. A node's own `icon` beats whatever its type or category would supply, so a pick from here is always the last word, and clearing it hands the choice back.

A node may also carry a `shape` (`rect` | `cylinder` | `square` | `circle` | `oval` | `diamond`) and its own `width`/`height`, which follow the same contract as `x`/`y`: present means a person sized it, absent means the shape's default. Square and circle always resolve to equal sides.

`cylinder` is the barrel a database is always drawn as, holding its own icon and name; its text clears the lid rather than straddling it.

`diamond` is a decision. It carries its question and no icon, and its four points sit mid-side, which is where links attach anyway.

A category may name the shape its boxes take, which is how the database family is drawn as barrels without anyone choosing it. That is resolved at layout rather than written onto a node when it is drawn, and the difference matters: a diagram made before its family had a shape picks the shape up, and a box follows its family if it is moved to another. A node that names its own shape is left alone — *including* one that names `rect`, which is how a database is told to be an ordinary box after all. That is also why the editor stores `rect` rather than leaving the field off when someone picks Box: leaving it off would hand the choice straight back to the family.

A barrel does not need a picture of a barrel inside it, so the generic database icon is dropped there and the title moves left to close the gap — name an engine and its own mark comes back.

### Networking

Networks are containers: a subnet is a group of `kind: 'network'` with a `cidr`, drawn dashed with a `▦` icon in its colour, enclosing every node whose `subnetId` points at it. Security groups are not containers — they tag nodes many-to-many — so they live in a `net` pool on the model and nodes reference them by `securityGroupIds`. Either way the object is defined once and referenced everywhere: rename it and every use follows.

Resting the pointer on a node shows a hover card: label and sublabel as a header, then aligned key/value rows — the node's `ip`, its subnet, its security groups, then `props` (a `Record<string, string | number | boolean>` a generator fills with resource properties, e.g. CloudFormation's `DBInstanceClass`), then free-text `info` lines (`key: value` becomes a row). This is the same card the infra panel draws for a scanned resource, which is what makes the two renderers interchangeable.

Containers are drawn outermost first, so a nested box paints over the one holding it — which, since a container's fill is faintly painted rather than hollow, is also what lets a pointer reach an inner container instead of stopping at its parent.

Containers hug their contents automatically, and are fitted innermost first, so a parent encloses its children rather than cutting through them. Nesting is declared by `parentId` or *implied*: when every node of one group is also in another, the first sits inside the second, which is what makes a container pad around a whole subnet rather than around the bare nodes that happen to sit in it. Give a group explicit `x/y/width/height` and it keeps that geometry instead — which is what you want for a hand-drawn VPC box that should stay put even when empty.

## The renderer

```html
<arch-diagram [model]="model" [mode]="'manual'" [editable]="true"
              (nodeMoved)="..." (nodeSelected)="..." (canvasClicked)="..." />
```

`editable` is the only difference between the two uses. Off, it is a picture: pan, zoom, hover-to-highlight. On, it adds selection and dragging.

A container is moved by its label band rather than anywhere inside it, so grabbing the empty space in a large container still pans, which is what people expect. Dragging carries the contents — the box keeps hugging them, it just does so somewhere else — and `groupMoved` reports whole-pixel deltas, carrying the leftover fraction into the next step so a slow drag does not round itself to a standstill.

Selection fires all three of `nodeSelected`, `edgeSelected` and `groupSelected` on every change, so a listener sees the whole picture and never has to clear the others itself — which it could only get right by knowing what order they arrive in.

Rendered from an Angular template rather than by building SVG in code, unlike the current infra panel. That costs a little on very large graphs and buys the ability to bind events straight to shapes — which is what makes the same component work as both a picture and a canvas.

## Connectors

Either end of an edge may be a container rather than a box: both are rectangles on the canvas, which is all the routing needs, so `from` and `to` resolve against groups as well as nodes. A link anchored to a container takes the container's colour, and is dropped when that container is deleted.

An edge leaves the side of its source that faces the target and enters the facing side of the target — sideways when the pair reads left/right, top/bottom when it reads stacked — so a connector never doubles back through its own box. `route` overrides that choice for the one link whose natural path runs through something else: `side` holds it to left and right, `stack` to top and bottom. `dir` puts an arrowhead at one end (`one`, the default) or both (`both`).

A labelled edge draws a chip behind its text so the connector does not run through the words. The chip is sized by measuring the label in a canvas with the same font rather than guessing from a character count — too narrow and the line shows through the ends of the text, too wide and it reads as a misplaced box.

Two boxes within 22 units of level are joined by a straight connector rather than an elbow, meeting in the middle of the difference. A jog of a few pixels reads as a mistake rather than as meaning something, and boxes of different heights placed by eye are rarely level to the pixel.

Elbows round by up to 8px, but never by more than half the offset they turn through. A fixed radius kinks: two 8px quarter-arcs need 16px of room, so between boxes only a few pixels out of line they overshoot each other and the path visibly doubles back. Clamping keeps tight turns square instead, which is what a right angle should look like.

Dashes animate: a one-way link marches toward its arrowhead, a two-way one washes out and back. `solid` has no dashes and so stays still. Clicking a connector selects it — a fat transparent twin of the path is the click target, since a 1.8px line is not one.

`speed` picks how long a dash takes to travel one pattern length: `slow` 2.4s, `normal` 1.2s, `fast` 0.6s, `turbo` 0.3s, from `EDGE_SPEED_MS`. A two-way link takes twice that to get back where it started. Every value is 300ms times a power of two, and that is a requirement rather than a convenience: it makes the longest cycle in any diagram a whole multiple of all the others, which is what lets a GIF of mixed speeds close. Adding a speed of, say, 450ms would break it — links would drift out of step and the export would seam.

## Still and animated export

`renderStill(scale)` rasterises the whole diagram as a PNG at `scale` device pixels per diagram unit — the editor asks for 3, so a picture holds up on a large screen or in print where matching the on-screen size would look soft. It is capped by total pixels rather than by width, since a tall diagram at a high scale exhausts canvas memory as readily as a wide one.

Both exports frame `contentBox()`, and so does `fit()`, so what you fit is what you get. It is *measured* off the rendered canvas rather than worked out from the model, because plenty of what a diagram draws is not the size of the thing it belongs to: a container's name is written from its corner and a long one runs well past its border, and a title wider than its box overhangs the same way. Adding up shapes misses all of it, and whatever is missed gets quietly cropped. Selection handles and the hover card are hidden for the measurement, since an export strips them too. The laid-out box — shapes and connector labels — stays as the fallback for when there is nothing rendered to measure.

Getting this wrong silently crops the picture, so it is worth a test: export, then check that no ink reaches the outer edge, since clipped content runs to the boundary while a correct frame leaves the padding clear. Compare against the background with a tolerance rather than exactly — the backdrop is drawn a few units oversized so the rasteriser cannot leave a half-transparent line of its own antialiasing around the picture, but a strict equality check will still read any softened pixel as content.

Both exports share `staticClone()`, which frames the whole diagram, drops the editor chrome and hover state, paints a backdrop and carries the component's own styles across — the clone keeps its content attributes, so the scoped rules still match it. Only the animation rules are dropped, because a still has to take its dash offset from an attribute rather than from whatever a paused keyframe would impose.

## Animated GIF

`captureLoop()` renders exactly one animation loop as still frames, 50ms apart. The loop is as long as the slowest cycle on the canvas — `loopMs()` — so it adapts: a diagram of `turbo` links exports 6 frames over 0.3s, while one containing a slow two-way link exports 96 frames over 4.8s. The dash pattern repeats every 14 user units, so a line shifted by 14 lands back on itself, and because every cycle divides the loop, all of them are back where they started when it ends.

Two things are worth checking whenever this changes, and both are cheap. That a full-period shift is invisible: render at dash offset 0 and −14 and compare bitmaps, they must be identical (−7 must not be, or the test proves nothing). And that the loop closes: render at time 0 and at `loopMs` and compare, with a quarter-loop frame as the control. Note that a *half*-loop frame is a poor control — it can legitimately match, since every link tends to sit on a pattern boundary there.

Resolution is spread over the loop rather than fixed: the scale is whatever fits a pixel budget across every frame, capped at 3000px wide and 4× life size. A short loop is therefore drawn larger than a long one — the same diagram exports at 3000×2057 for under a megabyte over 24 frames, and at 2135×1464 for a couple of megabytes over 96.

The palette is quantised from the first several frames together rather than from one. A single frame misses the shades that only appear once the dashes have moved, and a colour the palette lacks is approximated for the whole loop; the frames it is built from are held back and written once it exists. How many are held is decided once the first frame arrives, since at these resolutions a frame runs to tens of megabytes, and the sample handed to the quantiser is thinned to a fixed budget of pixels — a diagram is broad flat areas, so its palette survives sampling.

The loop covers the slowest cycle rather than the shortest span in which all frames repeat, and those differ for a two-way link: half way through its travel the picture matches its start, but the dashes are about to reverse rather than continue. Cutting the loop there would render a two-way link indistinguishable from a one-way one.

Frames come from a *clone* of the live SVG with each dash offset set by hand, rather than from screenshotting the running animation, so a capture is deterministic and does not depend on frame timing. The component's own scoped styles still apply to the clone — it keeps its content attributes — so only the animation rules need stripping. Frames are handed to the caller one at a time; fifty full-size bitmaps at once is a great deal of memory. The editor encodes them with `gifenc`, quantising one 256-colour palette from the opening frame and sharing it across the rest: only the dashes move, so the colours never change, which keeps the file small and stops the picture shimmering.

## Flows

A diagram can also carry *flows*: ordered journeys over the links it already
has. Playing one dims whatever the journey has not reached, walks a dot along
each hop in turn, and captions what is happening.

```ts
interface DiagramFlow {
  id: string;
  label: string;
  from: string;        // where the journey starts — a box or a container
  steps: FlowStep[];
  beatMs?: number;     // how long one hop takes. Default 600, rounded to 300s
  restBeats?: number;  // held still at the end, whole path lit. Default 2
  color?: string;      // the travelling dot. Absent is amber
}

interface FlowStep {
  to: string;          // where this hop ends
  edgeId?: string;     // the link travelled; absent means into a container
  label?: string;      // the caption; falls back to the link's or target's name
  detail?: string;     // a second line, e.g. the class doing the work
  beats?: number;      // how long the hop takes. Default 1
}
```

A flow is a **path**, not a set of links. It starts somewhere and moves to a
neighbour each time, which is why a step names where it is going rather than
how it gets there. Two things follow:

- **Direction is free.** If the link a hop names points the other way, the hop
  runs against the arrow. Nothing has to say "reverse", so a reply back up a
  two-way link is written the same as any other hop.
- **Containment is a hop.** A container can step to anything it holds, and a
  member back out to whatever holds it. There is no drawn route, so the dot
  goes straight there. That is what lets a journey say "and inside the store,
  this happens" without inventing a link that does not exist.

One beat is 600ms — 300ms times a power of two, like every edge speed — so a
flow's loop is a whole number of dash patterns and an exported GIF still
closes on itself. While a flow plays, every link but the one being travelled
holds its dashes still. That keeps the eye on the one thing moving, and it
also means the loop is the flow's own length rather than the lowest common
multiple of the flow and every dash speed, which for a fourteen-hop journey
would run to minutes.

The caption band is sized once, to the longest line any hop will ever show,
rather than to the hop on screen: a band that grew with the words would push a
later caption outside a frame the export measured at the start.

### Pace

`beatMs` sets how long one hop takes, chosen from **Pace** in the panel: 300,
600, 900, 1200 or 1800 milliseconds. Any whole number of 300ms works, and
anything else is rounded to one, because the dashes on the hop being travelled
turn over every 300ms — a beat that did not divide by it would leave them
mid-pattern when the loop came round, and the GIF would show a seam.

A single hop can be held longer than the others with `beats`, for a step that
deserves a moment to read.

Captures run at ten frames a second, so a slower pace buys a smoother
animation as well as a longer one. A flow at its quickest is captured at twenty
instead: three frames a hop is a stutter, not an animation.

### Exporting one

`Export animated GIF` captures the whole journey, caption and all, at the size
chosen in the panel. For the fourteen-hop sample:

| | Width | Frame | File |
|---|---|---|---|
| Standard | 1400 | 1400×971 | about 6 MB |
| High | 2000 | 2000×1388 | about 9 MB |
| Maximum | 2800 | 2800×1943 | about 14 MB |

A resolution is a resolution: it does not shrink when the flow is slowed down.
An earlier version spread one pixel budget across the whole loop, so a flow
slowed for readability came out smaller than the same flow at speed, which is
the opposite of what slowing it down is asking for. Length costs file size
instead, and the panel says what the file will be before the button is pressed.

That estimate is fitted, not assumed. A frame's cost grows with about the 0.6
power of its area rather than with the area itself, because drawing the same
picture larger adds pixels that neighbour pixels the encoder has already seen.
Within one diagram it lands inside a few per cent; between diagrams a denser
picture can cost a quarter more.

### Opening one from a link

`?diagram=<url>` opens a diagram instead of whatever this browser was last
working on, `&flow=<id>` plays a flow in it, and `&step=<n>` holds on one hop
rather than playing. So a link can point at the moment Kafka hands the order
over, not just at the picture. A diagram opened this way is not saved over the
one already there; it becomes the browser's copy only once something is
edited.

Two samples ship in `public/samples`:

```
/?diagram=/samples/online-order-into-exatouch.json&flow=fl_journey
/?diagram=/samples/my-architecture-complete.json&flow=fl_order
```

## Layout modes

| Mode | What it does |
|---|---|
| `manual` | Uses the coordinates on the model. Anything unplaced lands in a tidy grid. |
| `layered` | Ranks nodes into columns by longest path from a source, then a barycenter sweep to cut edge crossings. Sugiyama, essentially. |
| `force` | Repulsion between all pairs, springs along edges, a pull toward each category's centroid so families cluster, then hard collision passes. |

All three honour existing coordinates. That is not an accident — it is what lets a re-layout keep human edits.

## Running it

```bash
cd ~/personal/eleva-arch-draw
npx ng build arch-diagram     # the library
npx ng serve --port 4450      # the editor, on http://localhost:4450
```

## Using the editor

Pick a category on the left, click the canvas to drop a box. Click a box to edit its title, subtitle, icon, category and container. Drag to move — that is what makes it hand-placed. "Draw link" then click a target to connect two boxes. Containers are created on the left and assigned per box.

State lives in `localStorage` and survives a refresh. Export writes JSON; import reads it back, including a diagram produced by something else.

To draw a flow: **New flow**, select the box it starts from and press the
start button, then keep picking from the list of places the path can go next.
That list is everywhere a link leads, in either direction, plus anything a
container holds and whatever holds it — so a path is built by following the
diagram rather than by naming links. Tick *extend by clicking the canvas* to
add a hop by clicking the box itself. Only the last hop can be removed, since
dropping one from the middle would break the chain. The player in the toolbar
runs it, steps through it, and stops.

## What is left

### 1. Adopt the library in the infra panel

`eleva-aws-infra-control/src/app/pages/architecture.component.ts` currently owns its own types, palette, layout and SVG building. Replace the drawing half with the library:

```ts
// in eleva-aws-infra-control
"dependencies": { "arch-diagram": "file:../eleva-arch-draw/dist/arch-diagram" }
```

Then write an adapter that turns the CloudFormation resource list into a `DiagramModel` — categories already map one to one, and `TYPE_ICON` is already the library's `DEFAULT_TYPE_ICONS`. Keep `ControlApi` exactly as is; only the rendering changes.

The payoff is that "Open in editor" becomes possible: export the generated model, hand-tune it, and the tuned version renders in the panel.

### 2. Persist hand edits back to the panel

Once the panel renders from a `DiagramModel`, store an override map of `nodeId → {x, y}` next to the generated diagram. Merge it in before rendering. That is the whole feature — the layouts already respect coordinates.

### 3. Things the editor still lacks

- **SVG export.** `staticClone()` already builds a self-contained SVG; serialising it is most of the job.
- **Multi-select and alignment.** Drag a marquee, nudge with arrows, align edges.
- **Resizing a container by hand.** The model keeps explicit `width`/`height` and the layout honours them; only nodes have a resize handle so far.
- **Undo.** Every edit already goes through one `update()` funnel, so a history stack is a small change there.
- **Edge routing around boxes.** Connectors are orthogonal elbows through the midpoint; they can cross a box that sits between two others.

### 4. Known rough edges

- The editor's styles now sit near their budget again after the flow panel; `angular.json` allows 6 kB. Moving them to a `.scss` file would end the question.
- The `layered` rank walk stops at cycles rather than resolving them, so a cyclic graph lays out but not optimally.
- `force` runs 220 iterations synchronously. Past roughly 150 nodes that will block the frame; move it to a worker or yield between passes.
