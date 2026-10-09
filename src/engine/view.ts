import type { Content, GameState, GameView, PublicPlayer } from "../shared/types";
import { publicEstimate } from "./scoring";

/** Per-viewer projection: hides other players' secrets, RNG, and unrevealed next event. */
export function viewFor(content: Content, state: GameState, viewerId: string | null): GameView {
  const players: Record<string, PublicPlayer> = {};
  for (const [id, p] of Object.entries(state.players)) {
    const mine = id === viewerId || state.status === "finished";
    players[id] = {
      ...p,
      objectives: mine ? p.objectives : [],
      objectiveCount: p.objectives.length,
      abilityOffer: id === viewerId ? p.abilityOffer : [],
      objectiveOffer: id === viewerId ? p.objectiveOffer : [],
      scoreEstimate: state.status === "playing" || state.status === "finished" ? publicEstimate(content, state, id) : 0,
    };
  }
  const viewer = viewerId ? state.players[viewerId] : null;
  const canPeek = !!viewer && viewer.peekRound === state.round;
  const { rng: _rng, actions, nextEvent, players: _p, ...rest } = state;
  void _rng; void _p;
  return {
    ...rest,
    log: state.log.slice(-120),
    players,
    nextEvent: canPeek ? nextEvent : null,
    me: viewerId,
    actionCount: actions.length,
  };
}
