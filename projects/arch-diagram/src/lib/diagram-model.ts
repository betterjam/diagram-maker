/**
 * The diagram model both worlds share.
 *
 * A generated diagram and a hand-drawn one differ in exactly one way: whether
 * a node carries its own coordinates. Give a node `x`/`y` and it stays where
 * it was put; leave them off and a layout decides. Everything else — icons,
 * categories, containers, edges — is identical, so one renderer serves both
 * and there is only one thing to maintain.
 */

/** A visual family: colour, icon and a human label. */
export interface DiagramCategory {
  id: string;
  label: string;
  /** Emoji or a single glyph. Kept as text so nothing has to be bundled. */
  icon: string;
  color: string;
  /** What a box of this family is drawn as when one is dropped. */
  shape?: NodeShape;
}

/** How a node is drawn. Absent means `rect`. */
export type NodeShape = 'rect' | 'square' | 'circle' | 'oval' | 'cylinder' | 'diamond';

/**
 * A named network object defined once on the model and referenced by any
 * number of nodes — renaming it here renames it everywhere it appears.
 * Only security groups live in this pool: they tag nodes rather than contain
 * them. A subnet contains nodes, so a subnet is a group (kind `network`).
 */
export interface NetEntity {
  id: string;
  kind: 'securityGroup';
  name: string;
  /** Anything worth seeing on hover: a rule summary, an AZ, a gateway. */
  note?: string;
}

/** One box on the canvas. */
export interface DiagramNode {
  id: string;
  label: string;
  /** The small grey line under the title, usually a resource type. */
  sublabel?: string;
  /** Looked up in the icon registry; falls back to the category icon. */
  type?: string;
  /** Overrides the icon the type would give. */
  icon?: string;
  categoryId: string;
  /** The container this sits in, if any. */
  groupId?: string;
  shape?: NodeShape;

  /** This node's own address. Shown in the hover tooltip. */
  ip?: string;
  /** The `network`-kind group this node sits in. That group encloses it. */
  subnetId?: string;
  /** References into the model's `net` pool. A node can carry several. */
  securityGroupIds?: string[];

  /**
   * Key → value details for the hover card — resource properties from a
   * generator, e.g. CloudFormation's AllocatedStorage / DBInstanceClass.
   * Rendered as an aligned table in insertion order.
   */
  props?: Record<string, string | number | boolean>;

  /**
   * Free-form extra lines for the hover card, under the structured facts.
   * A line written as `key: value` renders as an aligned table row.
   */
  info?: string;

  /**
   * Where the node sits. Present means "a person put it here" and the layout
   * leaves it alone. Absent means "work it out".
   */
  x?: number;
  y?: number;

  /**
   * Same contract as x/y: present means "a person sized it", absent means the
   * shape's default. Square and circle always resolve to equal sides.
   */
  width?: number;
  height?: number;

  /** Anything the producer wants to carry through; ignored by the renderer. */
  meta?: Record<string, unknown>;
}

/**
 * A dashed container. Groups may nest, e.g. NETWORKING inside VPC.
 * A group of kind `network` is a subnet: it encloses the nodes whose
 * `subnetId` points at it, and its CIDR shows next to its label.
 */
export interface DiagramGroup {
  id: string;
  label: string;
  kind?: 'container' | 'network';
  /** Networks: the CIDR block, shown in the container header. */
  cidr?: string;
  /** Header glyph. Networks fall back to 🕸️; plain containers to none. */
  icon?: string;
  categoryId?: string;
  parentId?: string;
  /** Fixed geometry for a hand-placed container; otherwise it hugs its contents. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export type EdgeKind = 'solid' | 'dashed' | 'dotted';

/** The sides a link is held to. Absent means the pair facing the other end. */
export type EdgeRoute = 'side' | 'stack';

/** How fast a dashed link flows. Absent means `normal`. */
export type EdgeSpeed = 'slow' | 'normal' | 'fast' | 'turbo';

/**
 * Milliseconds a dash takes to travel one pattern length.
 *
 * <p>Every value is 300ms times a power of two, which is what keeps an
 * exported GIF honest: the largest period in a diagram is necessarily a whole
 * multiple of every other, so one loop of the slowest link is also a whole
 * number of loops of all the rest. Any new speed must keep that property —
 * 450ms, say, would not, and links at different speeds would drift apart and
 * put a visible seam in the GIF.</p>
 */
export const EDGE_SPEED_MS: Record<EdgeSpeed, number> = {
  slow: 2400,
  normal: 1200,
  fast: 600,
  turbo: 300,
};

/**
 * How long one hop of a flow takes, in milliseconds.
 *
 * <p>300ms times a power of two, like every edge speed, so a flow's loop is
 * always a whole number of dash patterns and an exported GIF still closes on
 * itself.</p>
 */
export const FLOW_BEAT_MS = 600;

/**
 * The paces a flow may run at, in milliseconds a hop.
 *
 * <p>Every one is a whole number of 300ms, which is what keeps a capture
 * closeable: the dashes on the hop being travelled turn over every 300ms, so
 * at any of these paces they land back where they started on the beat.</p>
 */
export const FLOW_BEAT_STEP_MS = 300;
export const FLOW_PACES: { ms: number; label: string }[] = [
  { ms: 300, label: 'Fast' },
  { ms: 600, label: 'Normal' },
  { ms: 900, label: 'Considered' },
  { ms: 1200, label: 'Slow' },
  { ms: 1800, label: 'Very slow' },
];

/**
 * One hop of a flow: a move from wherever the path stands to somewhere next
 * door.
 *
 * <p>A hop names its destination rather than its route, because the route is
 * already on the diagram. Which way along a link it travels follows from
 * where the path had got to, so a reply up a two-way link needs nothing said
 * about it.</p>
 */
export interface FlowStep {
  /** Where this hop ends: a box or a container. */
  to: string;
  /**
   * The link travelled to get there. Absent means the hop steps into a
   * container's member, or out to the container holding it — containment
   * rather than a connection, so there is no link to travel.
   */
  edgeId?: string;
  /** Shown while the hop runs. Falls back to the link's or the target's name. */
  label?: string;
  /** A second line under it, e.g. the class or method doing the work. */
  detail?: string;
  /** Beats this hop lasts. Absent means one. */
  beats?: number;
}

/**
 * An ordered journey across the diagram — a request, an order, a deploy.
 *
 * <p>A path, not a set of links: it starts somewhere and moves to a neighbour
 * each time, either along a link or into a container. A diagram may hold
 * several and show one at a time. Playing one dims everything the journey has
 * not reached yet, so the picture explains a sequence rather than a shape.</p>
 */
export interface DiagramFlow {
  id: string;
  label: string;
  /** Where the journey starts, by node or container id. */
  from: string;
  steps: FlowStep[];
  /**
   * How long one beat lasts, in milliseconds. Absent is {@link FLOW_BEAT_MS}.
   *
   * <p>Rounded to a whole number of {@link FLOW_BEAT_STEP_MS} when it is read,
   * so a hand-written value can never break a capture's loop.</p>
   */
  beatMs?: number;
  /** Beats held still at the end, whole path lit, before it loops. Default 2. */
  restBeats?: number;
  /** The travelling dot's colour. Absent is amber. */
  color?: string;
}

/** A relationship between two nodes. */
export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  kind?: EdgeKind;
  /** One arrowhead at the target, or one at each end. Absent means `one`. */
  dir?: 'one' | 'both';
  /** How fast the dashes travel. Nothing to animate on a `solid` link. */
  speed?: EdgeSpeed;
  /**
   * Which sides the link uses. Absent means whichever pair faces the other
   * end. `side` holds it to left and right, `stack` to top and bottom — for
   * the link whose natural route would run through something else.
   */
  route?: EdgeRoute;
  /** Overrides the colour taken from the source node's category. */
  color?: string;
}

export interface DiagramModel {
  /** Free text shown above the canvas. */
  title?: string;
  categories: DiagramCategory[];
  groups: DiagramGroup[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  /** Shared subnets and security groups, referenced from nodes by id. */
  net?: NetEntity[];
  /** Ordered journeys over those edges, played one at a time. */
  flows?: DiagramFlow[];
}

/**
 * The palette the infra panel already uses, so a generated diagram and a
 * hand-drawn one look like the same product.
 */
export const DEFAULT_CATEGORIES: DiagramCategory[] = [
  { id: 'traffic', label: 'Traffic / Users', icon: '👥', color: '#eab308' },
  { id: 'dns', label: 'DNS', icon: '🌐', color: '#a78bfa' },
  { id: 'edge', label: 'Edge / CDN', icon: '☁️', color: '#38bdf8' },
  { id: 'net', label: 'Networking', icon: '🕸️', color: '#2dd4bf' },
  { id: 'compute', label: 'Services', icon: '⚙️', color: '#34d399' },
  // Drawn as the barrel everyone draws a database as, holding its own icon
  // and name. Any box can be changed to another shape afterwards.
  { id: 'database', label: 'Database', icon: '@database', color: '#fb7185', shape: 'cylinder' },
  { id: 'storage', label: 'Storage', icon: '📦', color: '#f472b6' },
  { id: 'security', label: 'Security', icon: '🔒', color: '#f59e0b' },
  { id: 'repo', label: 'Repositories', icon: '📚', color: '#a3e635' },
  { id: 'pipeline', label: 'Pipelines', icon: '🚀', color: '#c084fc' },
  { id: 'misc', label: 'Other', icon: '🧩', color: '#818cf8' },
  { id: 'ops', label: 'Ops', icon: '⏰', color: '#94a3b8' },

  // The selling side of the business. Appended rather than mixed in, so the
  // ids the infra panel already writes keep their exact colours.
  { id: 'pos', label: 'Point of sale', icon: '💳', color: '#fb923c' },
  { id: 'kiosk', label: 'Kiosks', icon: '@kiosk', color: '#facc15' },
  { id: 'device', label: 'Devices', icon: '📟', color: '#a8a29e' },
  { id: 'orders', label: 'Orders', icon: '🧾', color: '#22d3ee' },
  { id: 'catalog', label: 'Catalog', icon: '🗂️', color: '#e879f9' },
  { id: 'kitchen', label: 'Kitchen', icon: '🍳', color: '#ef4444' },
  { id: 'customer', label: 'Customers', icon: '🧑', color: '#5eead4' },
];

/**
 * Resource type to glyph. Lifted from the infra panel so a diagram exported
 * from there keeps its icons when opened in the editor. Extend it rather than
 * replacing it — an unknown type just falls back to its category icon.
 */
export const DEFAULT_TYPE_ICONS: Record<string, string> = {
  'AWS::EC2::VPC': '🌐',
  'AWS::EC2::Subnet': '▦',
  'AWS::EC2::Instance': '🖥️',
  'AWS::EC2::InternetGateway': '🚪',
  'AWS::EC2::SecurityGroup': '🛡️',
  'AWS::RDS::DBInstance': '🐘',
  'AWS::RDS::DBSubnetGroup': '▦',
  'AWS::S3::Bucket': '🪣',
  'AWS::ECR::Repository': '📦',
  'AWS::ECS::Service': '⚙️',
  'AWS::ECS::Cluster': '🧊',
  'AWS::ECS::TaskDefinition': '📋',
  'AWS::Lambda::Function': 'ƒ',
  'AWS::Lambda::Url': '🔗',
  'AWS::ApplicationAutoScaling::ScalableTarget': '📈',
  'AWS::CloudFront::Distribution': '🌎',
  'AWS::ApiGatewayV2::Api': '🔌',
  'AWS::ApiGatewayV2::DomainName': '🏷️',
  'AWS::ApiGatewayV2::VpcLink': '🔗',
  'AWS::Route53::RecordSet': '🧭',
  'AWS::SecretsManager::Secret': '🔑',
  'AWS::IAM::User': '👤',
  'AWS::ServiceDiscovery::Service': '📇',
  'AWS::ServiceDiscovery::PrivateDnsNamespace': '📇',
  'AWS::Scheduler::ScheduleGroup': '⏰',
  'AWS::SNS::Topic': '📣',
  'AWS::WAFv2::WebACL': '🛡️',
  'AWS::CodePipeline::Pipeline': '🚀',
  'External::User': '👥',
  'CICD::Pipeline': '🚀',
  'GitHub::Repository': '📚',

  // Commerce, so a subtitle picks up its glyph the same way a resource does.
  'POS::Terminal': '💳',
  'POS::Kiosk': '@kiosk',
  'POS::Printer': '🖨️',
  'Store::Location': '🏪',
  'Order::Service': '🧾',
  'Order::Queue': '🔔',
  'Cart::Service': '🛒',
  'Catalog::Service': '🗂️',
  'Catalog::Product': '🛍️',
  'Menu::Service': '📖',
  'KDS::Display': '🍳',
  'Kitchen::Station': '🍽️',
  'Inventory::Service': '📦',
  'Pricing::Service': '🏷️',
  'Promotion::Service': '🎟️',
  'Payment::Gateway': '💰',
  'Loyalty::Service': '⭐',
  'Delivery::Service': '🛵',
  'Customer::App': '📱',
  'Reporting::Service': '📊',

  // The hardware on the counter, which a diagram of a shop is half made of.
  'Device::Terminal': '💳',
  'Device::Kiosk': '@kiosk',
  'Device::Printer': '🖨️',
  'Device::Scanner': '🔍',
  'Device::CardReader': '🏧',
  'Device::Display': '📺',
  'Device::CashDrawer': '💵',
  'Device::Scale': '⚖️',
  'Device::Handheld': '📱',
  'Device::Tablet': '📲',
  'Device::Router': '📡',

  // Database engines. `AWS::RDS::DBInstance` keeps the elephant it has in the
  // infra panel; these are for saying which engine a hand-drawn box holds.
  'DB::Instance': '@database',
  'DB::Postgres': '🐘',
  'DB::MySQL': '🐬',
  'DB::SQLite': '🪶',
  'DB::SQLServer': '🪟',
  'DB::Cache': '⚡',
  'DB::Warehouse': '🧊',
  'DB::Search': '🔎',
};

/**
 * Icons drawn rather than typed, for the things emoji has no glyph for.
 *
 * <p>Referenced as `@name`, which keeps an icon a plain string — the model
 * stays JSON, and anything that does not recognise the prefix simply prints
 * it. Each path is drawn in a 24×24 box, stroked in the node's own colour
 * rather than coloured in, so it sits with the box instead of on top of it.</p>
 */
export const VECTOR_ICONS: Record<string, string> = {
  // A screen on a pedestal: the self-service kiosk you stand at to order.
  kiosk:
    'M6.5 3h11a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5h-11' +
    'a1.5 1.5 0 0 1-1.5-1.5v-11a1.5 1.5 0 0 1 1.5-1.5z' +
    'M12 17v3M8 20.5h8M8.5 13.5h7',

  // The stack of platters every architecture diagram draws a database as.
  // The file-cabinet emoji is the nearest typed equivalent and reads as
  // furniture rather than as storage.
  database:
    'M5 6a7 3 0 0 1 14 0a7 3 0 0 1-14 0' +
    'M5 6v12a7 3 0 0 0 14 0V6' +
    'M5 12a7 3 0 0 0 14 0',
};

export const VECTOR_PREFIX = '@';

/** The path behind an `@name` icon, or null for ordinary text and emoji. */
export function vectorIconPath(icon: string | undefined): string | null {
  if (!icon || !icon.startsWith(VECTOR_PREFIX)) return null;
  return VECTOR_ICONS[icon.slice(VECTOR_PREFIX.length)] ?? null;
}

/** One glyph offered by the picker, with the name it is offered under. */
export interface IconChoice {
  char: string;
  label: string;
}

export interface IconSection {
  label: string;
  icons: IconChoice[];
}

/**
 * The glyphs a person can put on a box, grouped the way they would look for
 * them.
 *
 * <p>Kept as text rather than artwork so nothing has to be bundled or
 * fetched, which is the same bargain the categories make. A node's own
 * `icon` wins over anything its type or category would supply, so choosing
 * from here is always the last word.</p>
 */
export const ICON_LIBRARY: IconSection[] = [
  {
    label: 'Devices',
    icons: [
      { char: '💳', label: 'POS terminal' },
      { char: '@kiosk', label: 'Kiosk' },
      { char: '🖥️', label: 'Monitor' },
      { char: '📱', label: 'Handheld' },
      { char: '📲', label: 'Tablet' },
      { char: '🖨️', label: 'Receipt printer' },
      { char: '🏧', label: 'Card reader' },
      { char: '📺', label: 'Customer display' },
      { char: '💵', label: 'Cash drawer' },
      { char: '🔍', label: 'Scanner' },
      { char: '⚖️', label: 'Scale' },
      { char: '📡', label: 'Router' },
      { char: '📟', label: 'Terminal' },
    ],
  },
  {
    label: 'Selling',
    icons: [
      { char: '🏪', label: 'Store' },
      { char: '🧾', label: 'Order' },
      { char: '🛒', label: 'Cart' },
      { char: '🛍️', label: 'Products' },
      { char: '🗂️', label: 'Catalog' },
      { char: '📦', label: 'Inventory' },
      { char: '🏷️', label: 'Price' },
      { char: '🎟️', label: 'Promotion' },
    ],
  },
  {
    label: 'Databases',
    icons: [
      { char: '@database', label: 'Database' },
      { char: '🐘', label: 'PostgreSQL' },
      { char: '🐬', label: 'MySQL' },
      { char: '🪶', label: 'SQLite' },
      { char: '🪟', label: 'SQL Server' },
      { char: '🧊', label: 'Warehouse' },
      { char: '⚡', label: 'Cache' },
      { char: '🔎', label: 'Search index' },
    ],
  },
  {
    label: 'Kitchen & service',
    icons: [
      { char: '🍳', label: 'KDS' },
      { char: '📖', label: 'Menu' },
      { char: '🍽️', label: 'Kitchen' },
      { char: '🍴', label: 'Service' },
      { char: '🪑', label: 'Table' },
      { char: '🛵', label: 'Delivery' },
    ],
  },
  {
    label: 'Customer',
    icons: [
      { char: '🧑', label: 'Customer' },
      { char: '👥', label: 'Users' },
      { char: '⭐', label: 'Loyalty' },
      { char: '💰', label: 'Payment' },
      { char: '🎁', label: 'Gift card' },
      { char: '📣', label: 'Marketing' },
    ],
  },
  {
    label: 'Operations',
    icons: [
      { char: '📊', label: 'Reports' },
      { char: '🔔', label: 'Notifications' },
      { char: '⏰', label: 'Scheduled job' },
      { char: '🎧', label: 'Support' },
      { char: '📄', label: 'Document' },
      { char: '🧮', label: 'Accounting' },
    ],
  },
  {
    label: 'Systems',
    icons: [
      { char: '☁️', label: 'Cloud' },
      { char: '🌐', label: 'Network' },
      { char: '🗄️', label: 'Database' },
      { char: '🔒', label: 'Security' },
      { char: '🔌', label: 'API' },
      { char: '🚀', label: 'Pipeline' },
      { char: '⚙️', label: 'Service' },
      { char: '🧊', label: 'Cluster' },
      { char: '🧩', label: 'Other' },
    ],
  },
];

/**
 * Brings a diagram's palette up to date with the library's.
 *
 * <p>A model carries its own copy of the categories so it can travel — open
 * it anywhere and the colours come with it. The cost is that the copy is a
 * snapshot: a diagram saved last month has last month's families, so
 * anything the library has learned since, like the shape a database is drawn
 * as or a new family to sort boxes into, never reaches it. Known families are
 * therefore taken from the library, which owns them; families it does not
 * know are left exactly as they are, since those came from somewhere else and
 * this is not the place to have an opinion about them.</p>
 */
export function withDefaultCategories(model: DiagramModel): DiagramModel {
  const known = new Set(DEFAULT_CATEGORIES.map((c) => c.id));
  const theirs = (model.categories ?? []).filter((c) => !known.has(c.id));
  return { ...model, categories: [...DEFAULT_CATEGORIES, ...theirs] };
}

export function emptyDiagram(title = 'Untitled diagram'): DiagramModel {
  return { title, categories: [...DEFAULT_CATEGORIES], groups: [], nodes: [], edges: [], net: [] };
}

/** Colour for a node, taken from its category. */
export function categoryColor(model: DiagramModel, categoryId: string): string {
  return model.categories.find((c) => c.id === categoryId)?.color ?? '#818cf8';
}

/** Icon for a node: explicit first, then its type, then its category. */
export function nodeIcon(
  model: DiagramModel,
  node: DiagramNode,
  typeIcons: Record<string, string> = DEFAULT_TYPE_ICONS,
): string {
  if (node.icon) return node.icon;
  if (node.type && typeIcons[node.type]) return typeIcons[node.type];
  return model.categories.find((c) => c.id === node.categoryId)?.icon ?? '🧩';
}

/** True when every node has been placed, so no layout pass is needed. */
export function isFullyPlaced(model: DiagramModel): boolean {
  return model.nodes.length > 0 && model.nodes.every((n) => n.x != null && n.y != null);
}
