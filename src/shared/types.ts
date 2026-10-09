// ============================================================
// Shared types — engine / server / client 共用
// ============================================================

export type ResourceKey = "money" | "influence" | "info";
export type Resources = Partial<Record<ResourceKey, number>>;
export const RESOURCE_KEYS: ResourceKey[] = ["money", "influence", "info"];

// ---------- Content definitions (data/*.json) ----------

export interface POIDef {
  id: string;
  name: string;
  category: string;
  tier: 1 | 2 | 3;
  lat: number;
  lng: number;
  region: string; // 行政區
  district: string; // gameplay district id
  tags: string[];
  investCost: number;
  income: Resources;
  explore: Resources;
  workPay: number;
  defense: number;
  blurb: string;
  source: string;
  verified: boolean;
  last_verified: string | null;
}

export interface EdgeDef {
  from: string;
  to: string;
  type: "walk" | "road" | "rail";
  cost?: number; // computed if absent
  distanceKm?: number; // computed
}

export interface DistrictDef {
  id: string;
  name: string;
  theme: string;
  color: string;
  description: string;
  dominanceBonus: Resources;
}

export interface Scope {
  district?: string;
  tag?: string; // "a|b" = either
  category?: string;
  poi?: string;
}

export type EffectDef =
  | { type: "modifier"; key: ModifierKey; scope: Scope; value?: number; resources?: Resources; duration: number }
  | { type: "close"; scope: Scope; duration: number }
  | { type: "grant"; target: GrantTarget; scope?: Scope; resources: Resources }
  | { type: "upkeep"; scope: Scope; money: number }
  | { type: "spotlight"; duration: number }
  | { type: "spawn_contract"; count: number; scope: Scope }
  | { type: "chain"; next: string; delay: number }
  | { type: "city"; stat: CityStat; value: number }
  | { type: "reveal_next" };

export type ModifierKey =
  | "move_cost_add"
  | "income_mult"
  | "work_pay_mult"
  | "invest_cost_mult"
  | "explore_bonus"
  | "investigate_bonus"
  | "transit_ap_add";

export type GrantTarget = "all" | "leader" | "not_leader" | "struggling" | "lowest" | "at_scope";

export interface EventDef {
  id: string;
  name: string;
  kind: "global" | "district" | "poi" | "player";
  weight?: number;
  minRound?: number;
  maxRound?: number; // negative = relative to total rounds
  chainOnly?: boolean;
  text: string;
  bind?: { district?: boolean; poi?: { tag: string }; player?: "leader" };
  effects: EffectDef[];
}

export interface CrisisDef {
  id: string;
  name: string;
  text: string;
  respondTags: string;
  respondCost: Resources;
  targetPerPlayer: number;
  onStart: EffectDef[];
  success: { topVP: number; vpPerContribution: number; text: string };
  failure: { vp: number; text: string };
}

export type AbilityEffect =
  | { type: "free_move_visited"; value: number }
  | { type: "explore_bonus"; resources: Resources }
  | { type: "edge_cost_cap"; value: number }
  | { type: "vp_per_stat"; stat: string; every: number; vp: number }
  | { type: "first_invest_category_refund"; money: number }
  | { type: "invest_cost_mult"; value: number }
  | { type: "work_pay_mult"; value: number }
  | { type: "income_mult"; value: number }
  | { type: "trade_bonus"; resources: Resources }
  | { type: "contract_bonus"; resources: Resources }
  | { type: "ap_override"; action: ActionType; value: number }
  | { type: "trade_anywhere"; value: number }
  | { type: "action_bonus"; action: ActionType; resources: Resources }
  | { type: "see_next_event"; value: number }
  | { type: "can_sell_info"; value: number }
  | { type: "sell_info_bonus"; money: number }
  | { type: "contest_bonus"; value: number }
  | { type: "defense_bonus"; value: number }
  | { type: "build_cost_mult"; value: number }
  | { type: "ap_bonus"; value: number }
  | { type: "upkeep_money"; value: number }
  | { type: "crisis_multiplier"; value: number };

export interface AbilityDef {
  id: string;
  name: string;
  direction: string;
  description: string;
  effects: AbilityEffect[];
}

export interface Condition {
  kind:
    | "stat"
    | "resource"
    | "control_tag"
    | "control_count"
    | "synergies"
    | "districts_explored"
    | "tier_explored"
    | "dominance"
    | "flag";
  key?: string;
  op: ">=" | "<=";
  value: number;
}

export interface ObjectiveDef {
  id: string;
  name: string;
  description: string;
  vp: number;
  conditions: Condition[];
}

export interface IdentityDef {
  id: string;
  name: string;
  icon: string;
  description: string;
  start: Resources;
}

export interface SynergyDef {
  id: string;
  name: string;
  requires: string[]; // each entry: tag or "a|b"; each satisfied by a distinct POI
  perRound: Resources;
  vp: number;
  description: string;
}

export interface CityGoalDef {
  id: string;
  name: string;
  description: string;
  scoring: {
    kind: "control_tag" | "stat";
    key: string;
    vpEach: number;
    every?: number;
    topBonus: number;
    topStat?: string;
    topResource?: ResourceKey;
  };
}

export interface Rules {
  baseAP: number;
  defaultRounds: number;
  roundOptions: number[];
  minPlayers: number;
  maxPlayers: number;
  startingResources: Resources;
  apCost: Record<string, number | null>;
  edgeCostByKm: [number, number][];
  edgeTypeCost: Record<string, number>;
  openingRounds: number;
  finaleRounds: number;
  abilityDraftRounds: number[];
  maxStakesPerPoi: number;
  maxLevel: number;
  contestInfluenceCost: number;
  contestMaxInfoSpend: number;
  struggleThreshold: number;
  recoverThreshold: number;
  controlUpkeepFree: number;
  controlUpkeepPerExtra: number;
  leaderInvestSurcharge: number;
  sellInfoPrice: number;
  contractMinReward: number;
  contractDuration: number;
  npcContractsPerRound: number;
  turnTimeoutSec: number;
  influencePerVP: number;
  explorePerVP: number;
  buildCostFactor: number;
}

export interface Content {
  rules: Rules;
  pois: POIDef[];
  poiById: Record<string, POIDef>;
  edges: EdgeDef[];
  adjacency: Record<string, { to: string; edge: EdgeDef }[]>;
  districts: DistrictDef[];
  districtById: Record<string, DistrictDef>;
  events: EventDef[];
  eventById: Record<string, EventDef>;
  crises: CrisisDef[];
  abilities: AbilityDef[];
  abilityById: Record<string, AbilityDef>;
  objectives: ObjectiveDef[];
  objectiveById: Record<string, ObjectiveDef>;
  identities: IdentityDef[];
  synergies: SynergyDef[];
  cityGoals: CityGoalDef[];
}

// ---------- Game state ----------

export type GameStatus = "lobby" | "identity" | "playing" | "finished";
export type CityStat = "commerce" | "culture" | "mobility" | "nature" | "tourism" | "knowledge" | "order";
export type BotStrategy = "random" | "greedy" | "explorer" | "trader" | "aggressive";

export interface PlayerState {
  id: string;
  name: string;
  color: string;
  isBot: boolean;
  botStrategy?: BotStrategy;
  autoPlayed?: boolean; // AI took over at least once
  position: string | null;
  ap: number;
  resources: Required<Resources>;
  directions: string[];
  abilities: string[];
  objectives: string[];
  identityDone: boolean;
  // private offers (hidden from others)
  abilityOffer: string[];
  objectiveOffer: string[];
  visited: string[]; // explored POIs
  stats: Record<string, number>;
  flags: Record<string, boolean>;
  investedCategories: string[];
  struggling: boolean;
  turn: { freeMoveUsed: boolean; investigated: string[]; worked: string[] };
  peekRound: number; // round number whose next-event this player can see
  directionActs: Record<string, number>; // action history per direction (for identity %)
}

export interface POIState {
  stakes: Record<string, number>;
  owner: string | null;
  level: number;
  activity: number;
  closedUntil: number; // closed through this round (inclusive)
}

export interface ActiveModifier {
  id: string;
  source: string;
  key: ModifierKey;
  scope: Scope;
  value?: number;
  resources?: Resources;
  untilRound: number; // inclusive
}

export interface EventInstance {
  eventId: string;
  round: number;
  name: string;
  text: string;
  vars: Record<string, string>;
  kind: EventDef["kind"] | "crisis";
}

export interface Contract {
  id: string;
  poster: string | "city";
  poiId: string;
  reward: Resources;
  acceptedBy: string | null;
  expiresRound: number;
  underground?: boolean; // only struggling players may take
  status: "open" | "accepted" | "done" | "expired";
  note?: string;
}

export interface TradeOffer {
  id: string;
  from: string;
  to: string;
  give: Resources;
  want: Resources;
  round: number;
  status: "open" | "accepted" | "declined" | "cancelled" | "expired";
}

export interface CrisisState {
  crisisId: string;
  startRound: number;
  target: number;
  contributions: Record<string, number>;
  resolved?: "success" | "failure";
}

export interface LogEntry {
  t: number; // timestamp
  round: number;
  playerId?: string;
  kind: "action" | "event" | "system" | "turn" | "crisis" | "contest" | "trade";
  text: string;
}

export interface ActionRecord {
  seq: number;
  t: number;
  round: number;
  playerId: string;
  action: Action;
  ok: boolean;
  auto?: boolean;
}

export interface ScoreBreakdown {
  assets: number;
  influence: number;
  control: number;
  exploration: number;
  synergy: number;
  dominance: number;
  cityGoal: number;
  crisis: number;
  objectives: number;
  abilities: number;
  total: number;
  completedObjectives: string[];
}

export interface GameResult {
  scores: Record<string, ScoreBreakdown>;
  ranking: string[];
  winners: string[];
  report: CityReport;
}

export interface CityReport {
  headline: string;
  playerLines: { playerId: string; title: string; line: string }[];
  districtLines: { districtId: string; line: string }[];
  highlights: { label: string; text: string }[];
  achievements: { playerId: string; id: string; name: string }[];
}

export interface GameState {
  id: string;
  code: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  status: GameStatus;
  hostId: string;
  settings: { totalRounds: number; turnTimeoutSec: number };
  round: number;
  turnOrder: string[];
  turnIndex: number;
  turnStartedAt: number;
  players: Record<string, PlayerState>;
  playerOrder: string[]; // join order
  pois: Record<string, POIState>;
  rng: { seed: number; state: number };
  modifiers: ActiveModifier[];
  currentEvents: EventInstance[];
  nextEvent: EventInstance | null; // pre-rolled; revealed to peekers
  scheduled: { eventId: string; round: number; vars: Record<string, string> }[];
  eventHistory: EventInstance[];
  cityGoalId: string;
  crisisRound: number;
  crisis: CrisisState | null;
  contracts: Contract[];
  trades: TradeOffer[];
  city: Record<CityStat, number>;
  log: LogEntry[];
  actions: ActionRecord[];
  counters: { seq: number; id: number };
  result: GameResult | null;
  debug: boolean;
}

// ---------- Actions ----------

export type Action =
  | { type: "SET_IDENTITY"; directions: string[]; abilityId: string; objectiveIds: string[]; startPoi: string }
  | { type: "CHOOSE_ABILITY"; abilityId: string }
  | { type: "MOVE"; to: string }
  | { type: "TRANSIT"; to: string }
  | { type: "EXPLORE" }
  | { type: "INVESTIGATE" }
  | { type: "WORK" }
  | { type: "INVEST" }
  | { type: "BUILD" }
  | { type: "CONTEST"; infoSpend?: number }
  | { type: "TRADE_OFFER"; to: string; give: Resources; want: Resources }
  | { type: "TRADE_RESPOND"; tradeId: string; accept: boolean }
  | { type: "TRADE_CANCEL"; tradeId: string }
  | { type: "POST_CONTRACT"; poiId: string; reward: number }
  | { type: "ACCEPT_CONTRACT"; contractId: string }
  | { type: "RESPOND_CRISIS" }
  | { type: "SELL_INFO" }
  | { type: "END_TURN" };

export type ActionType = Action["type"];

export interface ActionResult {
  ok: boolean;
  error?: string;
  messages: string[];
}

// Public view returned to clients
export interface PublicPlayer extends Omit<PlayerState, "abilityOffer" | "objectiveOffer" | "objectives"> {
  objectives: string[]; // own only; others get []
  objectiveCount: number;
  abilityOffer: string[]; // own only
  objectiveOffer: string[]; // own only
  scoreEstimate: number;
}

export interface GameView extends Omit<GameState, "players" | "rng" | "nextEvent" | "actions"> {
  players: Record<string, PublicPlayer>;
  nextEvent: EventInstance | null; // null unless viewer may peek
  me: string | null;
  actionCount: number;
}
