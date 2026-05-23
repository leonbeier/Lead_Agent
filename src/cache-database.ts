import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CompanyScreeningDatabase, CompanyScreeningRecord, LiveExaCache, RawExaHistoryEntry } from "./types";

type MetadataKey = "screeningMigrated" | "liveExaMigrated" | "testLabExaMigrated";

function normalizeDomain(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function buildScreeningKey(record: CompanyScreeningRecord): string {
  return normalizeDomain(record.normalizedDomain ?? record.domain) || `name:${record.normalizedName.trim().toLowerCase()}`;
}

export class CacheDatabaseStore {
  constructor(private readonly filePath: string) {}

  private withDatabase<T>(callback: (database: DatabaseSync) => T): T {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const database = new DatabaseSync(this.filePath);

    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS screening_records (
          record_key TEXT PRIMARY KEY,
          company_name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          domain TEXT,
          normalized_domain TEXT,
          category TEXT,
          relevance_score REAL,
          rationale TEXT,
          source_filter TEXT,
          short_description TEXT,
          checked_at TEXT,
          exists_in_hubspot INTEGER,
          hubspot_checked_at TEXT
        );

        CREATE TABLE IF NOT EXISTS discovered_domains (
          domain TEXT PRIMARY KEY,
          last_seen_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS live_exa_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          domain TEXT NOT NULL,
          company_name TEXT,
          discovery_query TEXT,
          source_filter TEXT
        );

        CREATE TABLE IF NOT EXISTS testlab_exa_queries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          query TEXT NOT NULL
        );
      `);

      return callback(database);
    } finally {
      database.close();
    }
  }

  getMetadata(key: MetadataKey): string | undefined {
    return this.withDatabase((database) => {
      const row = database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value;
    });
  }

  setMetadata(key: MetadataKey, value: string): void {
    this.withDatabase((database) => {
      database.prepare(`
        INSERT INTO metadata (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, value);
    });
  }

  readScreeningDatabase(): CompanyScreeningDatabase {
    return this.withDatabase((database) => {
      const rows = database.prepare(`
        SELECT company_name, normalized_name, domain, normalized_domain, category, relevance_score, rationale, source_filter, short_description, checked_at, exists_in_hubspot, hubspot_checked_at
        FROM screening_records
        ORDER BY COALESCE(checked_at, hubspot_checked_at, '') DESC
      `).all() as Array<{
        company_name: string;
        normalized_name: string;
        domain: string | null;
        normalized_domain: string | null;
        category: CompanyScreeningRecord["category"] | null;
        relevance_score: number | null;
        rationale: string | null;
        source_filter: string | null;
        short_description: string | null;
        checked_at: string | null;
        exists_in_hubspot: number | null;
        hubspot_checked_at: string | null;
      }>;

      return {
        records: rows.map((row) => ({
          companyName: row.company_name,
          normalizedName: row.normalized_name,
          domain: row.domain ?? undefined,
          normalizedDomain: row.normalized_domain ?? undefined,
          category: row.category ?? undefined,
          relevanceScore: row.relevance_score ?? undefined,
          rationale: row.rationale ?? undefined,
          sourceFilter: row.source_filter ?? undefined,
          shortDescription: row.short_description ?? undefined,
          checkedAt: row.checked_at ?? undefined,
          existsInHubSpot: row.exists_in_hubspot == null ? undefined : Boolean(row.exists_in_hubspot),
          hubspotCheckedAt: row.hubspot_checked_at ?? undefined
        }))
      };
    });
  }

  writeScreeningDatabase(databaseState: CompanyScreeningDatabase): void {
    this.withDatabase((database) => {
      database.exec("DELETE FROM screening_records");
      const statement = database.prepare(`
        INSERT INTO screening_records (
          record_key, company_name, normalized_name, domain, normalized_domain, category, relevance_score, rationale, source_filter, short_description, checked_at, exists_in_hubspot, hubspot_checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const record of databaseState.records) {
        statement.run(
          buildScreeningKey(record),
          record.companyName,
          record.normalizedName,
          record.domain ?? null,
          normalizeDomain(record.normalizedDomain ?? record.domain) ?? null,
          record.category ?? null,
          record.relevanceScore ?? null,
          record.rationale ?? null,
          record.sourceFilter ?? null,
          record.shortDescription ?? null,
          record.checkedAt ?? null,
          typeof record.existsInHubSpot === "boolean" ? Number(record.existsInHubSpot) : null,
          record.hubspotCheckedAt ?? null
        );
      }
    });
  }

  readLiveExaCache(): LiveExaCache {
    return this.withDatabase((database) => {
      const entries = database.prepare(`
        SELECT timestamp, domain, company_name, discovery_query, source_filter
        FROM live_exa_entries
        ORDER BY timestamp DESC, id DESC
      `).all() as Array<{
        timestamp: string;
        domain: string;
        company_name: string | null;
        discovery_query: string | null;
        source_filter: string | null;
      }>;
      const discoveredDomains = database.prepare(`
        SELECT domain
        FROM discovered_domains
        ORDER BY last_seen_at DESC, domain ASC
      `).all() as Array<{ domain: string }>;

      return {
        entries: entries.map<RawExaHistoryEntry>((entry) => ({
          timestamp: entry.timestamp,
          domain: entry.domain,
          companyName: entry.company_name ?? undefined,
          discoveryQuery: entry.discovery_query ?? undefined,
          sourceFilter: entry.source_filter ?? undefined
        })),
        discoveredDomains: discoveredDomains.map((entry) => entry.domain)
      };
    });
  }

  writeLiveExaCache(cache: LiveExaCache): void {
    this.withDatabase((database) => {
      database.exec("DELETE FROM live_exa_entries; DELETE FROM discovered_domains;");
      const entryStatement = database.prepare(`
        INSERT INTO live_exa_entries (timestamp, domain, company_name, discovery_query, source_filter)
        VALUES (?, ?, ?, ?, ?)
      `);
      const domainStatement = database.prepare(`
        INSERT INTO discovered_domains (domain, last_seen_at)
        VALUES (?, ?)
      `);

      for (const entry of cache.entries) {
        entryStatement.run(
          entry.timestamp,
          entry.domain,
          entry.companyName ?? null,
          entry.discoveryQuery ?? null,
          entry.sourceFilter ?? null
        );
      }

      for (const domain of cache.discoveredDomains) {
        domainStatement.run(domain, new Date().toISOString());
      }
    });
  }

  readTestLabExaCache(): { queryHistory: string[]; discoveredDomains: string[] } {
    return this.withDatabase((database) => {
      const queryHistory = database.prepare(`
        SELECT query
        FROM testlab_exa_queries
        ORDER BY id ASC
      `).all() as Array<{ query: string }>;
      const discoveredDomains = database.prepare(`
        SELECT domain
        FROM discovered_domains
        ORDER BY last_seen_at DESC, domain ASC
      `).all() as Array<{ domain: string }>;

      return {
        queryHistory: queryHistory.map((entry) => entry.query),
        discoveredDomains: discoveredDomains.map((entry) => entry.domain)
      };
    });
  }

  writeTestLabExaCache(cache: { queryHistory: string[]; discoveredDomains: string[] }): void {
    this.withDatabase((database) => {
      database.exec("DELETE FROM testlab_exa_queries; DELETE FROM discovered_domains;");
      const queryStatement = database.prepare(`
        INSERT INTO testlab_exa_queries (created_at, query)
        VALUES (?, ?)
      `);
      const domainStatement = database.prepare(`
        INSERT INTO discovered_domains (domain, last_seen_at)
        VALUES (?, ?)
      `);
      const now = new Date().toISOString();

      for (const query of cache.queryHistory) {
        queryStatement.run(now, query);
      }

      for (const domain of cache.discoveredDomains) {
        domainStatement.run(domain, now);
      }
    });
  }
}