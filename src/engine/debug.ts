import type { Content, GameState, Resources } from "../shared/types";
import { gain, log } from "./helpers";
import { applyEvent, rollEvent } from "./events";
import { applyAction } from "./game";

export type DebugCommand =
  | { cmd: "give"; playerId: string; resources: Resources }
  | { cmd: "give_ap"; playerId: string; ap: number }
  | { cmd: "move"; playerId: string; poiId: string }
  | { cmd: "set_owner"; poiId: string; playerId: string | null }
  | { cmd: "trigger_event"; eventId: string }
  | { cmd: "complete_objective"; playerId: string; objectiveId: string }
  | { cmd: "advance_turn" };

/** Development-only cheats. Server only exposes these when ENABLE_DEBUG=true. */
export function runDebug(content: Content, state: GameState, c: DebugCommand): string {
  const P = (id: string) => {
    const p = state.players[id];
    if (!p) throw new Error("unknown player");
    return p;
  };
  switch (c.cmd) {
    case "give": gain(P(c.playerId), c.resources); break;
    case "give_ap": P(c.playerId).ap += c.ap; break;
    case "move":
      if (!content.poiById[c.poiId]) throw new Error("unknown poi");
      P(c.playerId).position = c.poiId;
      break;
    case "set_owner": {
      const s = state.pois[c.poiId];
      if (!s) throw new Error("unknown poi");
      s.stakes = c.playerId ? { [c.playerId]: 3 } : {};
      s.owner = c.playerId;
      break;
    }
    case "trigger_event": {
      const def = content.eventById[c.eventId];
      if (!def) throw new Error("unknown event");
      state.scheduled.push({ eventId: def.id, round: state.round, vars: {} });
      const inst = rollEvent(content, state, state.round);
      if (def.bind?.district && !inst.vars.district) inst.vars.district = content.districts[0].id;
      applyEvent(content, state, inst);
      break;
    }
    case "complete_objective": {
      const p = P(c.playerId);
      const def = content.objectiveById[c.objectiveId];
      if (!def) throw new Error("unknown objective");
      for (const cond of def.conditions) {
        if (cond.kind === "stat" && cond.op === ">=") p.stats[cond.key!] = cond.value;
        if (cond.kind === "flag") p.flags[cond.key!] = true;
        if (cond.kind === "resource") p.resources[cond.key as "money"] = cond.value;
      }
      break;
    }
    case "advance_turn": {
      const pid = state.turnOrder[state.turnIndex];
      if (pid) applyAction(content, state, pid, { type: "END_TURN" });
      break;
    }
  }
  log(state, "system", `[DEBUG] ${c.cmd}`);
  state.version += 1;
  return "ok";
}
