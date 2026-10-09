import pg from "pg";
import type { GameState, ActionRecord } from "../shared/types";

export interface GameRecord {
  state: GameState;
  tokens: Record<string, string>; // playerId -> secret token (never sent to other players)
}

export interface Store {
  init(): Promise<void>;
  load(id: string): Promise<GameRecord | null>;
  findIdByCode(code: string): Promise<string | null>;
  save(rec: GameRecord, newActions: ActionRecord[]): Promise<void>;
  listRecent(limit: number): Promise<{ id: string; code: string; status: string; players: number; round: number; updatedAt: number; state?: GameState }[]>;
  kind: string;
}

export class MemoryStore implements Store {
  kind = "memory";
  private games = new Map<string, GameRecord>();
  async init() {}
  async load(id: string) {
    const r = this.games.get(id);
    return r ? structuredClone(r) : null;
  }
  async findIdByCode(code: string) {
    for (const r of this.games.values()) if (r.state.code === code && r.state.status !== "finished") return r.state.id;
    for (const r of this.games.values()) if (r.state.code === code) return r.state.id;
    return null;
  }
  async save(rec: GameRecord) {
    this.games.set(rec.state.id, structuredClone(rec));
  }
  async listRecent(limit: number) {
    return [...this.games.values()]
      .sort((a, b) => b.state.updatedAt - a.state.updatedAt)
      .slice(0, limit)
      .map((r) => ({ id: r.state.id, code: r.state.code, status: r.state.status, players: r.state.playerOrder.length, round: r.state.round, updatedAt: r.state.updatedAt, state: r.state }));
  }
}

/**
 * PostgreSQL store. The game state snapshot is JSONB (engine is the source of truth),
 * while every action is also appended to a relational log for replay / analytics.
 */
export class PgStore implements Store {
  kind = "postgres";
  private pool: pg.Pool;
  constructor(url: string) {
    const ssl = process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined;
    this.pool = new pg.Pool({ connectionString: url, ssl, max: 5 });
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        status TEXT NOT NULL,
        round INT NOT NULL DEFAULT 0,
        players INT NOT NULL DEFAULT 0,
        state JSONB NOT NULL,
        tokens JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS games_code_idx ON games (code);
      CREATE INDEX IF NOT EXISTS games_updated_idx ON games (updated_at DESC);
      CREATE TABLE IF NOT EXISTS game_actions (
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        seq INT NOT NULL,
        round INT NOT NULL,
        player_id TEXT NOT NULL,
        action JSONB NOT NULL,
        ok BOOLEAN NOT NULL,
        auto BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (game_id, seq)
      );
    `);
  }
  async load(id: string) {
    const r = await this.pool.query("SELECT state, tokens FROM games WHERE id = $1", [id]);
    return r.rows[0] ? { state: r.rows[0].state as GameState, tokens: r.rows[0].tokens } : null;
  }
  async findIdByCode(code: string) {
    const r = await this.pool.query("SELECT id FROM games WHERE code = $1 ORDER BY (status <> 'finished') DESC, updated_at DESC LIMIT 1", [code]);
    return r.rows[0]?.id ?? null;
  }
  async save(rec: GameRecord, newActions: ActionRecord[]) {
    const s = rec.state;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO games (id, code, status, round, players, state, tokens, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (id) DO UPDATE SET status=$3, round=$4, players=$5, state=$6, tokens=$7, updated_at=now()`,
        [s.id, s.code, s.status, s.round, s.playerOrder.length, JSON.stringify(s), JSON.stringify(rec.tokens)],
      );
      for (const a of newActions) {
        await client.query(
          "INSERT INTO game_actions (game_id, seq, round, player_id, action, ok, auto) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
          [s.id, a.seq, a.round, a.playerId, JSON.stringify(a.action), a.ok, !!a.auto],
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  async listRecent(limit: number) {
    const r = await this.pool.query(
      "SELECT id, code, status, round, players, extract(epoch from updated_at)*1000 AS t, CASE WHEN status='finished' THEN state END AS state FROM games ORDER BY updated_at DESC LIMIT $1",
      [limit],
    );
    return r.rows.map((x) => ({ id: x.id, code: x.code, status: x.status, players: x.players, round: x.round, updatedAt: Number(x.t), state: x.state ?? undefined }));
  }
}
