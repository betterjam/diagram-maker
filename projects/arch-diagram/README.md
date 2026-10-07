# arch-diagram

The library behind Arch Draw: one model, one layout, one renderer, shared by
the editor in this repository and by the infra panel that generates diagrams
from CloudFormation.

- `diagram-model.ts` — the JSON a diagram is: categories, groups, nodes,
  edges, flows. A node with `x`/`y` stays where it was put; one without is
  placed by the layout.
- `diagram-layout.ts` — manual, layered and force layouts, and the fitting of
  containers around whatever they hold.
- `arch-diagram.component.ts` — the SVG renderer: shapes (box, cylinder,
  square, circle, oval, diamond), orthogonal links with optional forced
  routing, hover cards, flows and frame capture for PNG and GIF export.

Build it with `ng build arch-diagram`; the output lands in `dist/arch-diagram`,
which is where the editor's `tsconfig.json` points `arch-diagram` at.
