# Arch Draw

Draw architecture diagrams by hand, using the same model and renderer the
[Eleva infra panel](../eleva-aws-infra-control) uses for its generated ones.

A generated diagram and a hand-drawn one differ in exactly one thing: whether a
node carries its own coordinates. Give it `x`/`y` and it stays put; leave them
off and a layout decides. So one library serves both, and there is one thing to
maintain rather than two.

```bash
npm install
npm run build:lib   # the shared library, into dist/arch-diagram — the editor imports it from there
npm start           # the editor, on http://localhost:4450
```

Build the library again after changing anything under `projects/arch-diagram`,
and restart `npm start` afterwards: the dev server does not recover from the
library being rebuilt underneath it.

## What is where

| Path | What it holds |
|---|---|
| `projects/arch-diagram/` | The library: the model (`diagram-model.ts`), the layout (`diagram-layout.ts`) and the renderer (`arch-diagram.component.ts`). |
| `src/app/` | The editor: palette, panels, flows, export. |
| `public/samples/` | Example diagrams, opened with `/?diagram=/samples/<file>.json`. |
| `tools/` | Scripts that write a sample as code and check it before it is saved. |
| `docs/SPEC.md` | The design, and what is left to build. |

Families cover both infrastructure and the selling side — point of sale,
kiosks, devices, orders, catalog, kitchen, customers — and a selected box can
take any glyph from the picker in its panel, which has a group for the
hardware on the counter as well as for the software behind it. Containers
pick from the same list, and draw it beside their name.

A diagram can also carry flows: ordered journeys over its links, played as a
travelling dot with a caption, and exported as a looping GIF. A flow is a path
— it starts somewhere and steps to a neighbour each time, along a link or into
a container — so direction along a link works itself out.

```
/?diagram=/samples/online-order-into-exatouch.json&flow=fl_journey
```

Three samples live in `public/samples`: the path an online order takes into
Exatouch, the store network it crosses to get there, and how
ecommerce-infrastructure handles patching, vulnerability monitoring, deploys
and rollbacks. The last one is written by `tools/ecommerce-infra-diagram.py`,
which also checks the result — ids, links, flow hops, overlaps, text that
would not fit — so a large diagram can be kept as code.

Pace sets how long a hop takes, and a single hop can be held longer than the
rest. The GIF comes out at one of three widths, and the panel says how many
frames, how big and roughly how many megabytes before the button is pressed.

Pick a category on the left, click the canvas to drop a box, drag to place it,
"Draw link" to connect two — either end can be a container — and Delete
removes whatever is selected (after asking).
Click a connector to edit that link: label, one-way or two-way, dash style,
speed, reverse. Links animate — one-way dashes march toward the arrowhead,
two-way ones wash back and forth, at any of four speeds — and route out of
whichever side faces the target, unless the link is told to keep to left and
right or to top and bottom. Export writes a high-resolution PNG, or an
animated GIF of one full loop — however many speeds are in play — that
repeats seamlessly.
A selected box can change shape (box, cylinder, square, circle, oval, or a
diamond for a decision) — a
database arrives as a barrel already — be resized by its
corner handle, and carry network facts — an IP, a subnet, security groups —
shown as a hover card along with any generated resource properties. Subnets
and security groups are defined once and reused across boxes; a subnet is
itself a container that encloses its members. Containers are dashed boxes
that hug whatever you put in them — drag one by its header to move it and
everything inside, click that header to rename it, recolour it or nest it in
another container. Work is kept in the browser and can
be exported as JSON.

**The design, and what is left to build: [docs/SPEC.md](docs/SPEC.md).**
