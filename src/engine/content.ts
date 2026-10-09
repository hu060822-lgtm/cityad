import type { Content, POIDef, EdgeDef, Rules, DistrictDef, EventDef, CrisisDef, AbilityDef, ObjectiveDef, IdentityDef, SynergyDef, CityGoalDef } from "../shared/types";
import poisJson from "../../data/pois.json";
import edgesJson from "../../data/edges.json";
import rulesJson from "../../data/rules.json";
import districtsJson from "../../data/districts.json";
import eventsJson from "../../data/events.json";
import crisesJson from "../../data/crises.json";
import abilitiesJson from "../../data/abilities.json";
import objectivesJson from "../../data/objectives.json";
import identitiesJson from "../../data/identities.json";
import synergiesJson from "../../data/synergies.json";
import cityGoalsJson from "../../data/city_goals.json";

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function byId<T extends { id: string }>(list: T[]): Record<string, T> {
  return Object.fromEntries(list.map((x) => [x.id, x]));
}

/** Build a Content bundle from raw JSON. Computes edge distance/cost from real coordinates. */
export function buildContent(raw?: Partial<Record<string, unknown>>): Content {
  const rules = (raw?.rules ?? rulesJson) as Rules;
  const pois = (raw?.pois ?? poisJson) as POIDef[];
  const poiById = byId(pois);
  const edges = ((raw?.edges ?? edgesJson) as EdgeDef[]).map((e) => {
    const a = poiById[e.from];
    const b = poiById[e.to];
    if (!a || !b) throw new Error(`Edge references unknown POI: ${e.from} -> ${e.to}`);
    const distanceKm = Math.round(haversineKm(a, b) * 100) / 100;
    let cost = e.cost;
    if (cost == null) cost = rules.edgeTypeCost[e.type];
    if (cost == null) cost = rules.edgeCostByKm.find(([km]) => distanceKm <= km)![1];
    return { ...e, distanceKm, cost };
  });
  const adjacency: Content["adjacency"] = Object.fromEntries(pois.map((p) => [p.id, []]));
  for (const e of edges) {
    adjacency[e.from].push({ to: e.to, edge: e });
    adjacency[e.to].push({ to: e.from, edge: e });
  }
  const districts = (raw?.districts ?? districtsJson) as DistrictDef[];
  const events = (raw?.events ?? eventsJson) as EventDef[];
  const abilities = (raw?.abilities ?? abilitiesJson) as AbilityDef[];
  const objectives = (raw?.objectives ?? objectivesJson) as ObjectiveDef[];
  return {
    rules,
    pois,
    poiById,
    edges,
    adjacency,
    districts,
    districtById: byId(districts),
    events,
    eventById: byId(events),
    crises: (raw?.crises ?? crisesJson) as CrisisDef[],
    abilities,
    abilityById: byId(abilities),
    objectives,
    objectiveById: byId(objectives),
    identities: (raw?.identities ?? identitiesJson) as IdentityDef[],
    synergies: (raw?.synergies ?? synergiesJson) as SynergyDef[],
    cityGoals: (raw?.cityGoals ?? cityGoalsJson) as CityGoalDef[],
  };
}

/** Validate referential integrity of content. Returns list of problems (empty = OK). */
export function validateContent(c: Content): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const p of c.pois) {
    if (ids.has(p.id)) problems.push(`Duplicate POI id ${p.id}`);
    ids.add(p.id);
    if (!c.districtById[p.district]) problems.push(`POI ${p.id} has unknown district ${p.district}`);
    if (!(p.lat > 23.9 && p.lat < 24.5 && p.lng > 120.4 && p.lng < 121.1)) problems.push(`POI ${p.id} coordinates outside Taichung bbox`);
    if (!p.source) problems.push(`POI ${p.id} missing source`);
    if (c.adjacency[p.id].length === 0) problems.push(`POI ${p.id} is not connected`);
  }
  // connectivity
  const start = c.pois[0]?.id;
  if (start) {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      for (const { to } of c.adjacency[n]) if (!seen.has(to)) (seen.add(to), stack.push(to));
    }
    if (seen.size !== c.pois.length) problems.push(`Graph not connected: ${c.pois.length - seen.size} unreachable`);
  }
  for (const e of c.events) {
    for (const ef of e.effects) if (ef.type === "chain" && !c.eventById[ef.next]) problems.push(`Event ${e.id} chains to unknown ${ef.next}`);
  }
  for (const a of c.abilities) if (!c.identities.find((i) => i.id === a.direction)) problems.push(`Ability ${a.id} unknown direction`);
  if (!c.pois.some((p) => p.tags.includes("hub"))) problems.push("No hub POIs (players need a start location)");
  return problems;
}

let cached: Content | null = null;
export function getContent(): Content {
  if (!cached) cached = buildContent();
  return cached;
}
