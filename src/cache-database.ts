import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CompanyScreeningDatabase, CompanyScreeningRecord, ExaQueryHistoryInsight, LiveExaCache, LiveExaRecurringDomain, RawExaHistoryEntry } from "./types";

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

        CREATE TABLE IF NOT EXISTS live_exa_query_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          filter_name TEXT NOT NULL,
          query TEXT NOT NULL,
          planned_queries_json TEXT,
          prompt_messages_json TEXT,
          excluded_domains_json TEXT,
          excluded_domain_details_json TEXT
        );

        CREATE TABLE IF NOT EXISTS live_exa_domain_occurrences (
          domain TEXT PRIMARY KEY,
          occurrences INTEGER NOT NULL DEFAULT 0,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
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

      try {
        database.exec("ALTER TABLE testlab_exa_queries ADD COLUMN detected_categories_json TEXT;");
      } catch {
        // Already migrated.
      }

      try {
        database.exec("ALTER TABLE testlab_exa_queries ADD COLUMN note TEXT;");
      } catch {
        // Already migrated.
      }

      try {
        database.exec("ALTER TABLE live_exa_query_runs ADD COLUMN excluded_domain_details_json TEXT;");
      } catch {
        // Already migrated.
      }

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
      const queryRuns = database.prepare(`
        SELECT timestamp, filter_name, query, planned_queries_json, prompt_messages_json, excluded_domains_json, excluded_domain_details_json
        FROM live_exa_query_runs
        ORDER BY timestamp DESC, id DESC
      `).all() as Array<{
        timestamp: string;
        filter_name: string;
        query: string;
        planned_queries_json: string | null;
        prompt_messages_json: string | null;
        excluded_domains_json: string | null;
        excluded_domain_details_json: string | null;
      }>;

      return {
        entries: entries.map<RawExaHistoryEntry>((entry) => ({
          timestamp: entry.timestamp,
          domain: entry.domain,
          companyName: entry.company_name ?? undefined,
          discoveryQuery: entry.discovery_query ?? undefined,
          sourceFilter: entry.source_filter ?? undefined
        })),
        discoveredDomains: discoveredDomains.map((entry) => entry.domain),
        queryRuns: queryRuns.map((entry) => ({
          timestamp: entry.timestamp,
          filterName: entry.filter_name,
          query: entry.query,
          plannedQueries: entry.planned_queries_json ? JSON.parse(entry.planned_queries_json) as string[] : undefined,
          promptMessages: entry.prompt_messages_json ? JSON.parse(entry.prompt_messages_json) as Array<{ role: string; content: string }> : undefined,
          excludedDomains: entry.excluded_domains_json ? JSON.parse(entry.excluded_domains_json) as string[] : undefined,
          excludedDomainDetails: entry.excluded_domain_details_json
            ? JSON.parse(entry.excluded_domain_details_json) as NonNullable<LiveExaCache["queryRuns"]>[number]["excludedDomainDetails"]
            : undefined
        }))
      };
    });
  }

  writeLiveExaCache(cache: LiveExaCache): void {
    this.withDatabase((database) => {
      database.exec("DELETE FROM live_exa_entries; DELETE FROM discovered_domains; DELETE FROM live_exa_query_runs;");
      const entryStatement = database.prepare(`
        INSERT INTO live_exa_entries (timestamp, domain, company_name, discovery_query, source_filter)
        VALUES (?, ?, ?, ?, ?)
      `);
      const domainStatement = database.prepare(`
        INSERT INTO discovered_domains (domain, last_seen_at)
        VALUES (?, ?)
      `);
      const queryRunStatement = database.prepare(`
        INSERT INTO live_exa_query_runs (timestamp, filter_name, query, planned_queries_json, prompt_messages_json, excluded_domains_json, excluded_domain_details_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
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

      for (const queryRun of cache.queryRuns ?? []) {
        queryRunStatement.run(
          queryRun.timestamp,
          queryRun.filterName,
          queryRun.query,
          queryRun.plannedQueries ? JSON.stringify(queryRun.plannedQueries) : null,
          queryRun.promptMessages ? JSON.stringify(queryRun.promptMessages) : null,
          queryRun.excludedDomains ? JSON.stringify(queryRun.excludedDomains) : null,
          queryRun.excludedDomainDetails ? JSON.stringify(queryRun.excludedDomainDetails) : null
        );
      }
    });
  }

  /**
   * Persistently accumulates how often each domain has been returned by Exa across runs.
   * This counter is never bulk-deleted (unlike entries/discovered_domains), so historical
   * occurrence signal survives every new search and feeds the exclude prioritization.
   */
  recordLiveExaDomainOccurrences(records: RawExaHistoryEntry[]): void {
    if (records.length === 0) {
      return;
    }

    this.withDatabase((database) => {
      const statement = database.prepare(`
        INSERT INTO live_exa_domain_occurrences (domain, occurrences, first_seen_at, last_seen_at, company_name, discovery_query, source_filter)
        VALUES (?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT(domain) DO UPDATE SET
          occurrences = occurrences + 1,
          last_seen_at = excluded.last_seen_at,
          company_name = COALESCE(excluded.company_name, company_name),
          discovery_query = COALESCE(excluded.discovery_query, discovery_query),
          source_filter = COALESCE(excluded.source_filter, source_filter)
      `);

      for (const record of records) {
        const domain = normalizeDomain(record.domain);
        if (!domain) {
          continue;
        }

        const timestamp = record.timestamp?.trim() || new Date().toISOString();
        statement.run(
          domain,
          timestamp,
          timestamp,
          record.companyName ?? null,
          record.discoveryQuery ?? null,
          record.sourceFilter ?? null
        );
      }
    });
  }

  readLiveExaDomainOccurrences(): LiveExaRecurringDomain[] {
    return this.withDatabase((database) => {
      const rows = database.prepare(`
        SELECT domain, occurrences, last_seen_at, company_name, discovery_query, source_filter
        FROM live_exa_domain_occurrences
        ORDER BY occurrences DESC, last_seen_at DESC, domain ASC
      `).all() as Array<{
        domain: string;
        occurrences: number;
        last_seen_at: string;
        company_name: string | null;
        discovery_query: string | null;
        source_filter: string | null;
      }>;

      return rows.map<LiveExaRecurringDomain>((row) => ({
        domain: row.domain,
        occurrences: row.occurrences,
        priority: row.occurrences,
        lastSeenAt: row.last_seen_at,
        companyName: row.company_name ?? undefined,
        discoveryQuery: row.discovery_query ?? undefined,
        sourceFilter: row.source_filter ?? undefined
      }));
    });
  }

  countLiveExaDomainOccurrences(): { domains: number; totalOccurrences: number } {
    return this.withDatabase((database) => {
      const row = database.prepare(`
        SELECT COUNT(*) AS domains, COALESCE(SUM(occurrences), 0) AS total
        FROM live_exa_domain_occurrences
      `).get() as { domains: number; total: number };
      return { domains: row.domains, totalOccurrences: row.total };
    });
  }

  clearLiveExaDomainOccurrences(): void {
    this.withDatabase((database) => {
      database.exec("DELETE FROM live_exa_domain_occurrences;");
    });
  }

  readTestLabExaCache(): { queryHistory: string[]; queryInsights: ExaQueryHistoryInsight[]; discoveredDomains: string[] } {
    return this.withDatabase((database) => {
      const queryHistory = database.prepare(`
        SELECT created_at, query, detected_categories_json, note
        FROM testlab_exa_queries
        ORDER BY id ASC
      `).all() as Array<{ created_at: string; query: string; detected_categories_json?: string | null; note?: string | null }>;
      const discoveredDomains = database.prepare(`
        SELECT domain
        FROM discovered_domains
        ORDER BY last_seen_at DESC, domain ASC
      `).all() as Array<{ domain: string }>;

      return {
        queryHistory: queryHistory.map((entry) => entry.query),
        queryInsights: queryHistory.map((entry) => ({
          query: entry.query,
          timestamp: entry.created_at,
          detectedCategories: entry.detected_categories_json
            ? JSON.parse(entry.detected_categories_json) as ExaQueryHistoryInsight["detectedCategories"]
            : undefined,
          note: entry.note ?? undefined
        })),
        discoveredDomains: discoveredDomains.map((entry) => entry.domain)
      };
    });
  }

  writeTestLabExaCache(cache: { queryHistory: string[]; queryInsights?: ExaQueryHistoryInsight[]; discoveredDomains: string[] }): void {
    this.withDatabase((database) => {
      database.exec("DELETE FROM testlab_exa_queries; DELETE FROM discovered_domains;");
      const queryStatement = database.prepare(`
        INSERT INTO testlab_exa_queries (created_at, query, detected_categories_json, note)
        VALUES (?, ?, ?, ?)
      `);
      const domainStatement = database.prepare(`
        INSERT INTO discovered_domains (domain, last_seen_at)
        VALUES (?, ?)
      `);
      const now = new Date().toISOString();
      const queryInsightsByQuery = new Map<string, ExaQueryHistoryInsight[]>();

      for (const entry of cache.queryInsights ?? []) {
        const existingEntries = queryInsightsByQuery.get(entry.query) ?? [];
        existingEntries.push(entry);
        queryInsightsByQuery.set(entry.query, existingEntries);
      }

      for (const query of cache.queryHistory) {
        const insight = queryInsightsByQuery.get(query)?.shift();
        queryStatement.run(
          insight?.timestamp ?? now,
          query,
          insight?.detectedCategories?.length ? JSON.stringify(insight.detectedCategories) : null,
          insight?.note ?? null
        );
      }

      for (const domain of cache.discoveredDomains) {
        domainStatement.run(domain, now);
      }
    });
  }
}