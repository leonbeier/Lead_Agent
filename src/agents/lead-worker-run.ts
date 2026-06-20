import { ControlPlaneStore } from "../control-plane.js";
import { DebugConsoleService } from "../debug/test-console-service.js";
import { HubSpotClient, isPlausibleCompanyName, looksLikeHexOrUuidSlug } from "../clients/hubspot.js";
import { LeadPipelineAgent, EUROPEAN_TLDS } from "./lead-pipeline.js";
import { env } from "../config.js";
import type {
  OrganizationFilter,
  CompanySample,
  CompanyScreeningDatabase,
  CompanyScreeningRecord,
  ExaQueryHistoryInsight,
  GeneratedLeadRecord,
  LeadCategory,
  LeadLearningData,
  LeadJobRequest,
  LeadJobResult,
  LeadRunProgress,
  LiveExaExcludedDomainDetail,
  PreCategorizedCompany,
  PublicContactCandidate,
  ResearchBrief,
  SearchHistoryDecisionSample,
  SearchHistoryEntry,
  SelectableLeadCategory,
} from "../types.js";

type ContactDebugResult = Awaited<ReturnType<DebugConsoleService["discoverContactsForExecution"]>>;

type QueueName = "exa" | "ai" | "outreach" | "contact" | "hubspot" | "screening" | "history";

interface WorkerRunMetrics {
  exaRequests: number;
  exaBatchesStarted: number;
  exaReturnedResults: number;
  exaFilteredByExcludedDomains: number;
  exaDuplicatesRemoved: number;
  exaRawFound: number;
  aiAccepted: number;
  aiRejectedDifferentCategory: number;
  aiRejectedOther: number;
  aiRejectedUnreachable: number;
  outreachCompleted: number;
  outreachFailed: number;
  contactCompleted: number;
  contactFailed: number;
  hubspotWritten: number;
  hubspotSkippedOutOfScope: number;
  queueSizes: {
    exaInFlight: number;
    aiWaiting: number;
    aiInFlight: number;
    waitingAfterAi: number;
    outreachWaiting: number;
    outreachInFlight: number;
    contactWaiting: number;
    contactInFlight: number;
    hubspotWaiting: number;
    hubspotInFlight: number;
  };
}

interface WorkerRunProgress extends LeadRunProgress {
  runVariant: "worker_v2";
  workerMetrics: WorkerRunMetrics;
  debugMessages: string[];
  errorMessages: string[];
}

interface QualifiedCompanyState {
  key: string;
  company: PreCategorizedCompany;
  searchId?: string;
  source: "seed" | "exa";
  pipelineAssigned: boolean;
  researchBrief?: ResearchBrief;
  contacts: PublicContactCandidate[];
  outreachStatus: "queued" | "running" | "done" | "failed";
  contactStatus: "queued" | "running" | "done" | "failed";
  hubspotStatus: "pending" | "queued" | "running" | "done" | "failed" | "skipped";
  removed: boolean;
  completedAt?: string;
  hubspotError?: string;
}

interface SearchAggregate {
  id: string;
  filter: OrganizationFilter;
  page: number;
  requestedCount: number;
  executedQueries: number;
  queryTexts: string[];
  plannedQueries?: string[];
  promptMessages?: Array<{ role: string; content: string }>;
  excludedDomains?: string[];
  excludedDomainDetails?: LiveExaExcludedDomainDetail[];
  returnedResults?: number;
  filteredByExcludedDomains?: number;
  filteredByHubSpot?: number;
  filteredByRejectedWebsites?: number;
  filteredByCurrentRunCache?: number;
  duplicatesRemoved?: number;
  rawFound: number;
  categoryBreakdown: Record<LeadCategory, number>;
  queryStats: Array<{
    query: string;
    returnedResults: number;
    filteredByExcludedDomains: number;
    filteredByHubSpot: number;
    filteredByRejectedWebsites: number;
    filteredByCurrentRunCache: number;
    rawFound: number;
    duplicates: number;
    accepted: number;
    rejectedDifferentCategory: number;
    rejectedOther: number;
    categoryBreakdown: Record<LeadCategory, number>;
  }>;
  decisionSamples: SearchHistoryDecisionSample[];
}

interface PendingExaQueryPlan {
  remainingQueries: string[];
  plannedQueries: string[];
  defaultQueries?: string[];
  promptMessages?: Array<{ role: string; content: string }>;
}

type ScreeningTask =
  | { type: "upsert"; record: CompanyScreeningRecord }
  | { type: "remove"; key: string }
  | { type: "mark-hubspot"; key: string; companyName: string; domain?: string; category?: LeadCategory; sourceFilter?: string };

type HistoryTask =
  | { type: "upsert-search"; aggregate: SearchAggregate }
  | { type: "flush" };

interface WorkerRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: WorkerRunProgress) => void;
}

interface LeadWorkerRunDependencies {
  controlPlaneStore?: ControlPlaneStore;
  debugConsoleService?: DebugConsoleService;
  hubSpotClient?: HubSpotClient;
  leadPipelineAgent?: LeadPipelineAgent;
  contactTaskTimeoutMs?: number;
  hubspotTaskTimeoutMs?: number;
}

export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(item: T | undefined) => void> = [];
  private closed = false;

  enqueue(item: T): boolean {
    if (this.closed) {
      return false;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return true;
    }

    this.items.push(item);
    return true;
  }

  async dequeue(): Promise<T | undefined> {
    if (this.items.length > 0) {
      return this.items.shift();
    }

    if (this.closed) {
      return undefined;
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(undefined);
    }
  }

  clear(): void {
    this.items.length = 0;
  }

  get size(): number {
    return this.items.length;
  }
}

const SEARCH_BATCH_SIZE = 20;
const SEARCH_RESULT_HEADROOM = 4;
const SEARCH_IDLE_MS = 250;
const SCREENING_FLUSH_DEBOUNCE_MS = 500;
// Hard cap on the post-loop shutdown drain. Every lead is written to HubSpot inline while the run
// is active, so the final drain only flushes the internal screening/search-history caches and joins
// already-idle worker promises. A single hung cleanup worker (e.g. a screening-DB flush that never
// resolves) was observed freezing the run in stage=stopping for 16 minutes. Bounding the drain
// guarantees the run always reaches a terminal state; anything still pending after this is internal
// bookkeeping that is safe to abandon.
const SHUTDOWN_DRAIN_DEADLINE_MS = 120_000;
const SHUTDOWN_HEARTBEAT_MS = 1_000;
const DEBUG_MESSAGE_LIMIT = 60;
// Coherent end-to-end budget for discoverPublicContactsForExecution: page collection
// (2 x 45 s = ~92 s) + website extraction (45 s) + findPublicContactsFromPages
// (selectedContactsTimeoutMs 370 s) + LinkedIn enrichment (45 s) = ~552 s worst case. The cap must
// exceed that sum so a discovery that DID find personal LinkedIn contacts is written to HubSpot
// instead of being discarded as a timeout (the measured 2026-06-20 defect: Foundry returned 4/4
// LinkedIn for HyPlus/CASE but the 510 s cap fired first -> companies written with 0 contacts).
const DEFAULT_CONTACT_TASK_TIMEOUT_MS = 600_000;
const DEFAULT_HUBSPOT_TASK_TIMEOUT_MS = env.WORKER_HUBSPOT_TASK_TIMEOUT_MS;
// Bounds the authoritative identity/locality resolution that runs right before a HubSpot write.
// The underlying crawl is cached per domain (contact discovery already warmed it), so this is
// normally near-instant; the cap only guards against a cold or hung origin.
const IDENTITY_RESOLUTION_TIMEOUT_MS = 90_000;
const DEFAULT_EXA_DISCOVERY_TIMEOUT_MS = Math.max(180_000, env.EXA_REQUEST_TIMEOUT_MS);
const MIN_EXA_BATCH_REQUESTS = 2;
// Bounds the research-brief build in the outreach worker. buildResearchBriefForExecution runs a
// website crawl plus an Azure reasoning call; without a hard cap a single hung crawl/Azure request
// keeps outreachInFlight pinned above zero forever, so countDownstreamInFlight() never reaches 0 and
// the main loop can never break - the run then stays in stage=stopping indefinitely. The contact
// and HubSpot workers already race their long calls against a timeout; the outreach worker must do
// the same so every downstream task is guaranteed to settle and the run always terminates.
const RESEARCH_BRIEF_TASK_TIMEOUT_MS = 300_000;

// Hard safe ceilings for per-stage parallelism. The lead-agent runs on a single small container;
// unbounded request-supplied concurrency (settings have historically stored 200) saturates the
// event loop and the shared browser, which is the real root cause of empty name/country/contact
// extraction under load. These caps bound the damage regardless of what the request asks for.
//
// AI prefilter and outreach are Azure-chat + plain-HTTP bound (they do NOT use the shared
// Playwright browser): the open-crawler fetches the company's own site directly, and the Azure
// gpt-4.1-mini deployment serves 100K TPM / ~600 RPM (the global rate-limiter auto-tunes to it).
// They therefore tolerate higher fan-out and are the stages that most speed up an end-to-end run.
// Contact discovery and the HubSpot identity crawl DO drive the shared Chromium instance, so they
// stay low to avoid the documented /dev/shm OOM on Railway.
const MAX_AI_CONCURRENCY = 12;
const MAX_OUTREACH_CONCURRENCY = 10;
const MAX_CONTACT_CONCURRENCY = 4;
// When contact discovery returns zero contacts we re-attempt a bounded number of times before
// accepting an empty result, so a single load-induced crawl failure does not strand a company
// without any reachable contact.
const CONTACT_DISCOVERY_MAX_ATTEMPTS = 3;
const CONTACT_DISCOVERY_RETRY_DELAY_MS = 1_500;

// Raised when contact discovery exceeds its full per-company budget (contactTaskTimeoutMs). A
// timeout is fundamentally different from a transient crawl failure: the crawl already consumed its
// entire time window without finishing, so re-running it just hands the same slow/hung origin
// another full window. Because the shared Chromium browser is globally serialized, every wasted
// window blocks all other companies, which is the documented cause of the run exhausting its
// maxRuntimeMs and writing late companies to HubSpot without outreach/LinkedIn. We therefore mark
// budget timeouts with this sentinel and do NOT retry them - retries stay reserved for genuine
// transient failures (thrown network errors) that have a real chance of succeeding on a re-run.
class ContactWorkerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactWorkerTimeoutError";
  }
}

// Per-contact personalized outreach generation budget. Each contact gets its own message; a single
// slow generation must never block the HubSpot write, so it falls back to the company-level brief.
const PERSONALIZED_OUTREACH_PER_CONTACT_TIMEOUT_MS = 45_000;

function getExaDiscoveryTimeoutMs(queryCount: number): number {
  return Math.max(
    DEFAULT_EXA_DISCOVERY_TIMEOUT_MS,
    env.EXA_REQUEST_TIMEOUT_MS * Math.max(MIN_EXA_BATCH_REQUESTS, queryCount + 1)
  );
}

function summarizeContactChannels(contacts: PublicContactCandidate[]): string {
  const byLabel = new Map<string, number>();
  let withEmail = 0;
  let withPhone = 0;
  let withLinkedIn = 0;

  for (const contact of contacts) {
    byLabel.set(contact.label, (byLabel.get(contact.label) ?? 0) + 1);
    if (contact.email) {
      withEmail += 1;
    }
    if (contact.phone) {
      withPhone += 1;
    }
    if (contact.linkedinUrl) {
      withLinkedIn += 1;
    }
  }

  const labelSummary = Array.from(byLabel.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([label, count]) => `${label}:${count}`)
    .join(", ");

  return `channels(email=${withEmail}, phone=${withPhone}, linkedin=${withLinkedIn}) labels[${labelSummary || "none"}]`;
}

function createEmptyCategoryBreakdown(): Record<LeadCategory, number> {
  return {
    integrator_vision_industrial_ai: 0,
    integrator_vision_ai_consulting: 0,
    integrator_vision_ai_freelancer: 0,
    integrator_general_ai: 0,
    integrator_relevant_focus: 0,
    industrial_end_customer_scaled: 0,
    camera_manufacturer_partner: 0,
    machine_builder_ai_enablement: 0,
    machine_builder_vision_ai: 0,
    software_platform_embedding: 0,
    irrelevant: 0,
    other: 0
  };
}

function normalizeDomain(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }

  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

// A European country-code TLD is a reliable in-region signal on its own. A neutral/global TLD
// (.com, .io, .ai, .co, ...) carries no locality signal, so a company on such a domain may only be
// trusted as in-region when its country was positively verified from its own website.
function hasEuropeanTld(domain?: string): boolean {
  const normalized = normalizeDomain(domain);
  if (!normalized) {
    return false;
  }
  const hostname = normalized.split("/")[0];
  return EUROPEAN_TLDS.some((tld) => hostname.endsWith(tld));
}

function buildCompanyKey(company: { domain?: string; name: string }): string {
  return normalizeDomain(company.domain) ?? company.name.trim().toLowerCase();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildScreeningRecord(company: CompanySample | PreCategorizedCompany): CompanyScreeningRecord {
  const normalizedDomain = normalizeDomain(company.domain);
  return {
    companyName: company.name,
    normalizedName: company.name.trim().toLowerCase(),
    domain: company.domain,
    normalizedDomain,
    country: company.country?.trim() || undefined,
    category: "category" in company ? company.category : undefined,
    relevanceScore: "relevanceScore" in company ? company.relevanceScore : undefined,
    rationale: "rationale" in company ? company.rationale : undefined,
    sourceFilter: company.sourceFilter,
    shortDescription: company.shortDescription,
    checkedAt: new Date().toISOString(),
    existsInHubSpot: false
  };
}

function toGeneratedLeadRecord(state: QualifiedCompanyState): GeneratedLeadRecord {
  const contacts = state.contacts ?? [];
  const emails = Array.from(new Set(contacts.map((contact) => contact.email).filter((value): value is string => Boolean(value))));
  const phones = Array.from(new Set(contacts.map((contact) => contact.phone).filter((value): value is string => Boolean(value))));
  const sources = Array.from(new Set(contacts.map((contact) => contact.sourceUrl).filter(Boolean)));

  return {
    companyName: state.company.name,
    domain: state.company.domain,
    country: state.company.country,
    category: state.company.category,
    relevanceScore: state.company.relevanceScore,
    sourceFilter: state.company.sourceFilter,
    rationale: state.company.rationale,
    likelyGermanSpeaking: state.researchBrief?.likelyGermanSpeaking,
    outreachLanguage: state.researchBrief?.outreachLanguage,
    rankings: state.researchBrief?.rankings,
    businessPotentialEUR: state.researchBrief?.businessPotentialEUR,
    businessPotentialReasoning: state.researchBrief?.businessPotentialReasoning,
    targetIndustry: state.researchBrief?.targetIndustry,
    productsOffered: state.researchBrief?.productsOffered,
    overview: state.researchBrief?.overview,
    stillQualified: state.researchBrief?.stillQualified,
    qualificationDecisionReason: state.researchBrief?.qualificationDecisionReason,
    qualificationSummary: state.researchBrief?.qualificationSummary,
    linkedInConnectionRequest: state.researchBrief?.linkedInConnectionRequest,
    linkedInMessage: state.researchBrief?.linkedInMessage,
    emailSubject: state.researchBrief?.emailSubject,
    emailBody: state.researchBrief?.emailBody,
    phoneScript: state.researchBrief?.phoneScript,
    riskFlags: state.researchBrief?.riskFlags,
    publicContactEmails: emails,
    publicContactPhones: phones,
    publicContactSources: sources
  };
}

export class LeadWorkerRunService {
  private readonly controlPlaneStore: ControlPlaneStore;
  private readonly debugConsoleService: DebugConsoleService;
  private readonly hubSpotClient: HubSpotClient;
  private readonly leadPipelineAgent: LeadPipelineAgent;
  private readonly contactTaskTimeoutMs: number;
  private readonly hubspotTaskTimeoutMs: number;

  constructor(dependencies: LeadWorkerRunDependencies = {}) {
    this.controlPlaneStore = dependencies.controlPlaneStore ?? new ControlPlaneStore();
    this.hubSpotClient = dependencies.hubSpotClient ?? new HubSpotClient();
    // Share the worker's HubSpotClient with the contact-discovery service so both stages use ONE
    // crawl cache + ONE shared Chromium. Without this they ran two separate HubSpotClient instances
    // (two browsers, two caches): the pre-write identity crawl re-crawled the same anti-bot sites
    // the contact crawl had already fetched, doubling browser-lane contention and starving contact
    // discovery into writing companies with zero contacts under live load.
    this.debugConsoleService = dependencies.debugConsoleService ?? new DebugConsoleService({ hubspotClient: this.hubSpotClient });
    this.leadPipelineAgent = dependencies.leadPipelineAgent ?? new LeadPipelineAgent();
    this.contactTaskTimeoutMs = Math.max(1, dependencies.contactTaskTimeoutMs ?? DEFAULT_CONTACT_TASK_TIMEOUT_MS);
    this.hubspotTaskTimeoutMs = Math.max(1, dependencies.hubspotTaskTimeoutMs ?? DEFAULT_HUBSPOT_TASK_TIMEOUT_MS);
  }

  async run(request: LeadJobRequest, options: WorkerRunOptions = {}): Promise<LeadJobResult> {
    if (request.companySearchMode !== "exa_search") {
      throw new Error("Der neue Worker-Run unterstuetzt aktuell nur Exa Search.");
    }

    const targetCategories = Array.from(new Set((request.targetCategories ?? []).filter(
      (category): category is SelectableLeadCategory => category !== "irrelevant" && category !== "other"
    )));

    if (targetCategories.length === 0) {
      throw new Error("Mindestens eine Zielkategorie ist fuer den neuen Worker-Run erforderlich.");
    }

    const targetLeadCount = Math.max(1, request.targetLeadCount ?? 1);
    const deadlineMs = Date.now() + Math.max(60_000, request.maxRuntimeMs ?? 10 * 60_000);
    const aiConcurrency = Math.min(MAX_AI_CONCURRENCY, Math.max(1, request.aiPrefilterConcurrency ?? 2));
    const outreachConcurrency = Math.min(MAX_OUTREACH_CONCURRENCY, Math.max(1, request.outreachPrepConcurrency ?? 6));
    const contactConcurrency = Math.min(MAX_CONTACT_CONCURRENCY, Math.max(1, request.contactSearchConcurrency ?? 3));
    const exaQueryCount = Math.max(1, request.exaQueryCount ?? 4);
    const screeningDatabase = await this.controlPlaneStore.getCompanyScreeningDatabase();
    const learning = typeof this.controlPlaneStore.getLearning === "function"
      ? await this.controlPlaneStore.getLearning()
      : undefined;
    const filters = this.leadPipelineAgent.buildDirectExaFiltersForExecution(targetCategories, request.market);
    const defaultScopeFilter = filters[0];
    // The HubSpot write gate fails CLOSED on locality: a company with an empty resolved country and a
    // neutral/global TLD (.com/.io/.ai) is only written when its country was positively verified or it
    // sits on a European ccTLD. When the identity resolver is wired (always in production), apply that
    // SAME trust requirement already at the AI accept gate so region-unverifiable companies are dropped
    // BEFORE they consume the expensive, globally serialized contact-discovery budget instead of being
    // skipped only after a full crawl. The AI worker already runs one identity resolution for
    // empty-country target companies, so requiring trust here does not lose a write the gate would
    // have allowed — it just stops wasting contact discovery on leads that can never pass the gate.
    const resolverAvailable = typeof (this.hubSpotClient as { resolveCompanyAddress?: unknown }).resolveCompanyAddress === "function";
    const hasTrustedRegionSignal = (company: Pick<PreCategorizedCompany, "country" | "domain">): boolean =>
      !resolverAvailable
      || (company.country ?? "").trim().length > 0
      || hasEuropeanTld(company.domain);
    const exaConcurrency = Math.min(2, Math.max(1, filters.length));
    const hubspotConcurrency = 3;
    const aiQueue = new AsyncQueue<{ company: CompanySample; searchId?: string }>();
    const outreachQueue = new AsyncQueue<QualifiedCompanyState>();
    const contactQueue = new AsyncQueue<QualifiedCompanyState>();
    const hubspotQueue = new AsyncQueue<QualifiedCompanyState>();
    const screeningQueue = new AsyncQueue<ScreeningTask>();
    const historyQueue = new AsyncQueue<HistoryTask>();

    const qualifiedStates = new Map<string, QualifiedCompanyState>();
    const standbyQualifiedStates: QualifiedCompanyState[] = [];
    const searchAggregates = new Map<string, SearchAggregate>();
    const recentDebugMessages: string[] = [];
    const errorMessages: string[] = [];
    let liveSearchDebug: LeadRunProgress["liveSearchDebug"];
    const seenCompanyKeys = new Set<string>();
    const currentRunExcludedDomains = new Set<string>();
    const currentRunQueryHistory = new Map<string, ExaQueryHistoryInsight>(this.buildRecentLiveExaQueryHistory(learning));
    const pendingExaQueryPlans = new Map<string, PendingExaQueryPlan>();
    const metrics: WorkerRunMetrics = {
      exaRequests: 0,
      exaBatchesStarted: 0,
      exaReturnedResults: 0,
      exaFilteredByExcludedDomains: 0,
      exaDuplicatesRemoved: 0,
      exaRawFound: 0,
      aiAccepted: 0,
      aiRejectedDifferentCategory: 0,
      aiRejectedOther: 0,
      aiRejectedUnreachable: 0,
      outreachCompleted: 0,
      outreachFailed: 0,
      contactCompleted: 0,
      contactFailed: 0,
      hubspotWritten: 0,
      hubspotSkippedOutOfScope: 0,
      queueSizes: {
        exaInFlight: 0,
        aiWaiting: 0,
        aiInFlight: 0,
        waitingAfterAi: 0,
        outreachWaiting: 0,
        outreachInFlight: 0,
        contactWaiting: 0,
        contactInFlight: 0,
        hubspotWaiting: 0,
        hubspotInFlight: 0
      }
    };

    let screeningState: CompanyScreeningDatabase = screeningDatabase;
    let stopping = false;
    let timedOut = false;
    let searchCompleted = false;
    let stopReason = "";
    let searchCounter = 0;
    let completedExaWorkers = 0;
    let screeningFlushDue = false;
    // Counts companies enqueued for AI classification but not yet finished processing (waiting +
    // in-flight). It is incremented synchronously at every aiQueue.enqueue and decremented when the
    // AI worker finishes an item. We cannot derive this from aiQueue.size + aiInFlight: when an AI
    // worker is already idle-waiting, enqueue hands the item straight to that waiter (so it never
    // counts in aiQueue.size) and aiInFlight is only bumped a microtask later, leaving a brief
    // window where freshly enqueued seeds are invisible to neededCompanies() and the Exa worker
    // would start an unnecessary search before the seeds are even classified.
    let aiPendingCount = 0;

    const markQueueSizes = () => {
      metrics.queueSizes.aiWaiting = aiQueue.size;
      metrics.queueSizes.outreachWaiting = outreachQueue.size;
      metrics.queueSizes.contactWaiting = contactQueue.size;
      metrics.queueSizes.hubspotWaiting = hubspotQueue.size;
      metrics.queueSizes.waitingAfterAi = standbyQualifiedStates.length;
    };

    const log = (message: string) => {
      const stamped = `${new Date().toISOString()} ${message}`;
      recentDebugMessages.unshift(stamped);
      if (recentDebugMessages.length > DEBUG_MESSAGE_LIMIT) {
        recentDebugMessages.length = DEBUG_MESSAGE_LIMIT;
      }
      emitProgress();
    };

    const logError = (message: string) => {
      const stamped = `${new Date().toISOString()} ${message}`;
      errorMessages.unshift(stamped);
      log(message);
    };

    const countTotalQualifiedStates = () => Array.from(qualifiedStates.values()).filter((state) => !state.removed).length;
    const countHeldQualifiedStates = () => Array.from(qualifiedStates.values()).filter((state) => !state.removed && state.hubspotStatus !== "done").length;
    const countAssignedQualifiedStates = () => Array.from(qualifiedStates.values()).filter((state) => !state.removed && state.pipelineAssigned && state.hubspotStatus !== "done").length;
    const countDownstreamInFlight = () =>
      metrics.queueSizes.outreachInFlight + metrics.queueSizes.contactInFlight + metrics.queueSizes.hubspotInFlight + outreachQueue.size + contactQueue.size + hubspotQueue.size;
    const countAiPending = () => aiPendingCount;
    const neededCompanies = () => Math.max(0, targetLeadCount - metrics.hubspotWritten - countHeldQualifiedStates() - countAiPending());
    const hasReachedTarget = () => metrics.hubspotWritten >= targetLeadCount;
    const shouldStopNewPipelineWork = () => stopping || hasReachedTarget();
    const shouldDrainAcceptedCompaniesAfterSearchStop = () =>
      stopReason === "exa_search_unavailable"
      || stopReason === "exa_credits_exhausted"
      || stopReason === "runtime_limit_reached";
    const temporarilyUnavailableFilters = new Set<string>();
    let hadTemporaryExaFailure = false;

    const getNextSearchFilter = (): OrganizationFilter | undefined => {
      const availableFilters = filters.filter((filter) => !temporarilyUnavailableFilters.has(filter.name));
      if (availableFilters.length === 0) {
        return undefined;
      }

      return availableFilters[searchCounter % availableFilters.length];
    };

    const stopAiQueue = () => {
      // Don't clear the queue - let existing items finish processing
      // Only stop accepting new items
      aiQueue.close();
    };

    const bufferedLiveRawCompanies: CompanySample[] = [];
    const ingestRawCompanies = (rawCompanies: CompanySample[], searchId?: string, options: { countDuplicates?: boolean } = {}) => {
      const countDuplicates = options.countDuplicates ?? true;
      const aggregate = searchId ? searchAggregates.get(searchId) : undefined;
      const uniqueRawCompanies: CompanySample[] = [];
      for (const company of rawCompanies) {
        const key = buildCompanyKey(company);
        if (seenCompanyKeys.has(key)) {
          if (countDuplicates) {
            metrics.exaDuplicatesRemoved += 1;
            const query = company.discoveryQuery?.trim();
            if (aggregate && query) {
              getOrCreateQueryStat(aggregate, query).duplicates += 1;
            }
          }
          continue;
        }

        seenCompanyKeys.add(key);
        uniqueRawCompanies.push(company);
        bufferedLiveRawCompanies.push(company);
        metrics.exaRawFound += 1;
        const normalizedDomain = normalizeDomain(company.domain);
        if (normalizedDomain) {
          currentRunExcludedDomains.add(normalizedDomain);
        }
      }

      for (const company of uniqueRawCompanies.slice(0, SEARCH_BATCH_SIZE + SEARCH_RESULT_HEADROOM)) {
        // Only count a pending AI task when the item is actually accepted by the queue. enqueue is a
        // no-op once the queue is closed (stopAiQueue ran after a timeout/target/exa-stop); counting
        // it anyway would leak aiPendingCount permanently because no AI worker ever dequeues it, so
        // countAiPending() would stay > 0 forever and the main loop could never break (stage=stopping
        // would hang indefinitely). An Exa batch that returns right after the stop hits exactly this.
        if (aiQueue.enqueue({ company, searchId })) {
          aiPendingCount += 1;
        }
      }

      return uniqueRawCompanies;
    };

    const flushBufferedLiveRawCompanies = async () => {
      if (bufferedLiveRawCompanies.length === 0) {
        return;
      }

      const companiesToPersist = bufferedLiveRawCompanies.splice(0, bufferedLiveRawCompanies.length);
      await this.controlPlaneStore.recordLiveExaRawResults(companiesToPersist.map((company) => ({
        timestamp: new Date().toISOString(),
        domain: normalizeDomain(company.domain) ?? company.name.trim().toLowerCase(),
        companyName: company.name,
        discoveryQuery: company.discoveryQuery,
        sourceFilter: company.sourceFilter
      })));
    };

    const emitProgress = () => {
      markQueueSizes();
      const progressValue = Math.min(100, Math.round((metrics.hubspotWritten / targetLeadCount) * 100));
      const stage = stopping ? "stopping" : searchCompleted ? "finishing" : "running";
      const stageLabel = stopping ? "Worker-Run stoppt" : searchCompleted ? "Worker-Run schliesst ab" : "Worker-Run aktiv";
      const description = stopping
        ? "Neue Exa-Suchen sind gestoppt. Bereits freigegebene Firmen werden noch sauber zu Ende verarbeitet."
        : "Exa, KI, Outreach, Kontakte und HubSpot laufen als getrennte Worker-Queues parallel.";
      const progress: WorkerRunProgress = {
        runVariant: "worker_v2",
        stage,
        stageLabel,
        progressValue,
        progressMax: 100,
        progressDescription: description,
        detail: recentDebugMessages[0] ?? "Worker-Run initialisiert.",
        processedFilters: metrics.exaBatchesStarted,
        totalFilters: undefined,
        foundCandidates: countTotalQualifiedStates(),
        targetLeadCount,
        aiPrefilterConcurrency: aiConcurrency,
        outreachPrepConcurrency: outreachConcurrency,
        contactSearchConcurrency: contactConcurrency,
        exaQueryCount,
        funnel: {
          crawledPages: 0,
          afterCrawlerPrefilter: metrics.exaRawFound,
          afterHubSpotDedup: countTotalQualifiedStates(),
          afterAzureAICheck: metrics.aiAccepted,
          syncedToHubSpot: metrics.hubspotWritten
        },
        timedOut,
        stopped: stopping,
        liveSearchDebug,
        updatedAt: new Date().toISOString(),
        workerMetrics: {
          ...metrics,
          queueSizes: { ...metrics.queueSizes }
        },
        debugMessages: [...recentDebugMessages],
        errorMessages: [...errorMessages]
      };

      options.onProgress?.(progress);
    };

    const updateLiveSearchDebug = (aggregate: SearchAggregate | undefined, patch: Partial<NonNullable<LeadRunProgress["liveSearchDebug"]>> = {}) => {
      liveSearchDebug = {
        ...liveSearchDebug,
        ...patch,
        currentBatchQueryStats: aggregate
          ? aggregate.queryStats.map((queryStat) => ({
              query: queryStat.query,
              returnedResults: queryStat.returnedResults,
              filteredByExcludedDomains: queryStat.filteredByExcludedDomains,
              filteredByHubSpot: queryStat.filteredByHubSpot,
              filteredByRejectedWebsites: queryStat.filteredByRejectedWebsites,
              filteredByCurrentRunCache: queryStat.filteredByCurrentRunCache,
              rawFound: queryStat.rawFound,
              duplicates: queryStat.duplicates,
              accepted: queryStat.accepted,
              rejectedDifferentCategory: queryStat.rejectedDifferentCategory,
              rejectedOther: queryStat.rejectedOther,
              categoryBreakdown: { ...queryStat.categoryBreakdown }
            }))
          : liveSearchDebug?.currentBatchQueryStats
      };
    };

    const updateScreeningState = (task: ScreeningTask) => {
      if (task.type === "remove") {
        screeningState = {
          records: screeningState.records.filter((record) => buildCompanyKey({ name: record.companyName, domain: record.domain }) !== task.key)
        };
        return;
      }

      if (task.type === "mark-hubspot") {
        const key = task.key;
        const index = screeningState.records.findIndex((record) => buildCompanyKey({ name: record.companyName, domain: record.domain }) === key);
        const nextRecord: CompanyScreeningRecord = {
          ...(index >= 0 ? screeningState.records[index] : {
            companyName: task.companyName,
            normalizedName: task.companyName.trim().toLowerCase(),
            domain: task.domain,
            normalizedDomain: normalizeDomain(task.domain),
            category: task.category,
            sourceFilter: task.sourceFilter
          }),
          existsInHubSpot: true,
          hubspotCheckedAt: new Date().toISOString(),
          checkedAt: new Date().toISOString()
        };

        if (index >= 0) {
          screeningState.records[index] = nextRecord;
        } else {
          screeningState.records.unshift(nextRecord);
        }
        return;
      }

      const key = buildCompanyKey({ name: task.record.companyName, domain: task.record.domain });
      const index = screeningState.records.findIndex((record) => buildCompanyKey({ name: record.companyName, domain: record.domain }) === key);
      if (index >= 0) {
        screeningState.records[index] = {
          ...screeningState.records[index],
          ...task.record
        };
      } else {
        screeningState.records.unshift(task.record);
      }
    };

    const screeningWorker = async () => {
      while (true) {
        const task = await screeningQueue.dequeue();
        if (!task) {
          break;
        }

        updateScreeningState(task);
        screeningFlushDue = true;

        while (screeningQueue.size > 0) {
          const pendingTask = await screeningQueue.dequeue();
          if (!pendingTask) {
            break;
          }

          updateScreeningState(pendingTask);
        }

        await this.controlPlaneStore.writeCompanyScreeningDatabase(screeningState);
        screeningFlushDue = false;
      }
    };

    const historyWorker = async () => {
      while (true) {
        const task = await historyQueue.dequeue();
        if (!task) {
          break;
        }

        if (task.type === "upsert-search") {
          searchAggregates.set(task.aggregate.id, task.aggregate);
        }

        while (historyQueue.size > 0) {
          const pendingTask = await historyQueue.dequeue();
          if (!pendingTask) {
            break;
          }

          if (pendingTask.type === "upsert-search") {
            searchAggregates.set(pendingTask.aggregate.id, pendingTask.aggregate);
          }
        }

        const entries = Array.from(searchAggregates.values())
          .sort((left, right) => right.page - left.page)
          .map((aggregate) => {
            const relevantCount = targetCategories.reduce((count, category) => count + (aggregate.categoryBreakdown[category] ?? 0), 0);
            const returnedCount = Math.max(aggregate.rawFound, aggregate.decisionSamples.length);
            return {
              timestamp: new Date().toISOString(),
              companySearchMode: "exa_search",
              filterName: aggregate.filter.name,
              filterSnapshot: {
                persona: aggregate.filter.persona,
                industries: [...aggregate.filter.industries],
                keywords: [...aggregate.filter.keywords],
                locations: [...aggregate.filter.locations],
                employeeRanges: [...aggregate.filter.employeeRanges],
                notes: aggregate.filter.notes
              },
              targetCategory: aggregate.filter.targetCategories?.[0],
              batchType: "expand_50",
              page: aggregate.page,
              requestedCount: aggregate.requestedCount,
              returnedCount,
              relevantCount,
              relevanceRatio: returnedCount > 0 ? relevantCount / returnedCount : 0,
              categoryBreakdown: aggregate.categoryBreakdown,
              passedThreshold: relevantCount > 0,
              recommendation: relevantCount > 0 ? "keep-searching" : "broaden-query",
              fetchedSampleCount: aggregate.rawFound,
              eligibleSampleCount: relevantCount,
              discoveryQueries: aggregate.queryTexts,
              queryStats: aggregate.queryStats.map((queryStat) => ({ ...queryStat })),
              decisionSamples: aggregate.decisionSamples.slice(0, 10)
            } satisfies SearchHistoryEntry;
          });

        await this.controlPlaneStore.recordSearchHistory("exa_search", entries);
      }
    };

    const maybePromoteStandby = () => {
      // If stopping due to Exa error, promote all remaining standby companies so they still get processed
      // instead of being silently lost
      const promoteAll = stopping && !hasReachedTarget();
      
      while (standbyQualifiedStates.length > 0 && countAssignedQualifiedStates() < targetLeadCount && (promoteAll || !stopping)) {
        const nextState = standbyQualifiedStates.shift();
        if (!nextState) {
          return;
        }

        if (nextState.removed) {
          continue;
        }

        nextState.pipelineAssigned = true;
        outreachQueue.enqueue(nextState);
        contactQueue.enqueue(nextState);
        log(`Standby-Firma freigegeben: ${nextState.company.name}${promoteAll ? " (forced due to search error)" : ""}`);
      }
      emitProgress();
    };

    const queueQualifiedCompany = (company: PreCategorizedCompany, source: "seed" | "exa", searchId?: string) => {
      const key = buildCompanyKey(company);
      if (qualifiedStates.has(key) || standbyQualifiedStates.some((state) => state.key === key)) {
        return;
      }

      // Accept company even if we're stopping, but don't accept if target is reached
      if (hasReachedTarget()) {
        return;
      }

      const state: QualifiedCompanyState = {
        key,
        company,
        searchId,
        source,
        pipelineAssigned: false,
        contacts: [],
        outreachStatus: "queued",
        contactStatus: "queued",
        hubspotStatus: "pending",
        removed: false
      };

      metrics.aiAccepted += 1;
      const activeBefore = countAssignedQualifiedStates();
      qualifiedStates.set(key, state);
      if (activeBefore < targetLeadCount && (!stopping || shouldDrainAcceptedCompaniesAfterSearchStop())) {
        state.pipelineAssigned = true;
        outreachQueue.enqueue(state);
        contactQueue.enqueue(state);
        log(source === "seed"
          ? `Seed-Treffer aus Aussortiert-Liste freigegeben: ${company.name}`
          : `KI hat Zieltreffer freigegeben: ${company.name}`);
      } else {
        standbyQualifiedStates.push(state);
        screeningQueue.enqueue({
          type: "upsert",
          record: buildScreeningRecord(company)
        });
        log(source === "seed"
          ? `Seed-Treffer auf Warteliste gelegt: ${company.name} (stopping=${stopping})`
          : `KI-Treffer auf Warteliste gelegt: ${company.name} (stopping=${stopping})`);
      }
      emitProgress();
    };

    const queueNonTargetCompanyForCreation = (company: PreCategorizedCompany, source: "seed" | "exa", searchId?: string) => {
      log(`Nicht-Zieltreffer wird aussortiert: ${company.name} (${company.category})`);
      emitProgress();
    };

    const isCompanyInScope = async (
      company: Pick<PreCategorizedCompany, "country" | "domain">,
      filter = defaultScopeFilter
    ): Promise<boolean> => {
      if (!filter) {
        return true;
      }

      // Prefer the AI-backed, flexible region check so arbitrary markets ("EU und USA", "DACH", a
      // single country, ...) are honoured instead of a hardcoded country list. It is cached per
      // (market, country) on the agent and falls back to the deterministic check internally. Legacy
      // and test stubs that only expose the sync evaluator keep their existing behaviour.
      const asyncEvaluator = (this.leadPipelineAgent as { isCompanyInExecutionScopeAsync?: unknown } | undefined)
        ?.isCompanyInExecutionScopeAsync;
      if (typeof asyncEvaluator === "function") {
        return asyncEvaluator.call(this.leadPipelineAgent, company, filter, request.market);
      }

      const scopeEvaluator = (this.leadPipelineAgent as { isCompanyInExecutionScope?: unknown } | undefined)?.isCompanyInExecutionScope;
      if (typeof scopeEvaluator !== "function") {
        return true;
      }

      return scopeEvaluator.call(this.leadPipelineAgent, company, filter, request.market);
    };

    // Resolve a company's headquarters country from its own website via the AI identity resolver
    // (cached per domain). Used so that category-relevant companies always carry an evidence-based
    // location on their screening record — including the ones that get screened out — instead of an
    // empty field that hides the location in the Aussortiert list and risks re-pulling them later.
    const resolveVerifiedCountry = async (
      company: Pick<PreCategorizedCompany, "name" | "domain" | "country">
    ): Promise<string | undefined> => {
      const resolveIdentity = (this.hubSpotClient as { resolveCompanyAddress?: unknown }).resolveCompanyAddress;
      if (typeof resolveIdentity !== "function" || !company.domain) {
        return undefined;
      }
      let identityTimeout: ReturnType<typeof setTimeout> | undefined;
      const resolvedIdentity = await Promise.race([
        this.hubSpotClient.resolveCompanyAddress(company as PreCategorizedCompany),
        new Promise<null>((resolve) => {
          identityTimeout = setTimeout(() => resolve(null), IDENTITY_RESOLUTION_TIMEOUT_MS);
        })
      ]).catch(() => null);
      if (identityTimeout) {
        clearTimeout(identityTimeout);
      }
      return resolvedIdentity?.country?.trim() || undefined;
    };

    const maybeQueueHubSpot = (state: QualifiedCompanyState) => {
      if (state.removed || state.hubspotStatus !== "pending") {
        return;
      }

      if (state.outreachStatus !== "done") {
        return;
      }

      if (state.contactStatus !== "done" && state.contactStatus !== "failed") {
        return;
      }

      state.hubspotStatus = "queued";
      hubspotQueue.enqueue(state);
      emitProgress();
    };

    const aiWorkers = Array.from({ length: aiConcurrency }, () => (async () => {
      while (true) {
        const item = await aiQueue.dequeue();
        if (!item) {
          break;
        }

        metrics.queueSizes.aiInFlight += 1;
        emitProgress();
        try {
          const analysis = await this.debugConsoleService.classifyCompanyForExecution(item.company, {
            annotateDebugStage: false
          });
          const categorizedCompany = analysis.categorizedCompany;

          // Reachability gate: drop companies whose website does not load at all. classifyWebsite
          // sets websiteUnreachable=true only when every homepage URL fails to answer (a dead/hung
          // origin), never for a single failing subpage. Such companies are skipped entirely so no
          // qualified lead or non-target record is created from a stale search-index snapshot.
          if (analysis.websiteUnreachable) {
            metrics.aiRejectedUnreachable += 1;
            if (categorizedCompany.domain) {
              currentRunExcludedDomains.add(categorizedCompany.domain.trim().toLowerCase());
            }
            log(`Aussortiert (Website nicht erreichbar): ${categorizedCompany.name} (${categorizedCompany.domain})`);
            continue;
          }

          // Agent-first location backfill: when this is a category-relevant company but the prefilter
          // crawl could not determine its country, run the deeper AI identity resolver so the
          // screening record (also for screened-out companies) carries an evidence-based location and
          // the locality scope decision below runs on a verified country rather than an empty field.
          if (
            targetCategories.includes(categorizedCompany.category as SelectableLeadCategory) &&
            !(categorizedCompany.country ?? "").trim()
          ) {
            const verifiedCountry = await resolveVerifiedCountry(categorizedCompany);
            if (verifiedCountry) {
              categorizedCompany.country = verifiedCountry;
            }
          }

          screeningQueue.enqueue({
            type: "upsert",
            record: buildScreeningRecord(categorizedCompany)
          });

          if (item.searchId) {
            const aggregate = searchAggregates.get(item.searchId);
            if (aggregate) {
              aggregate.categoryBreakdown[categorizedCompany.category] += 1;
              aggregate.decisionSamples.unshift({
                companyName: categorizedCompany.name,
                domain: categorizedCompany.domain,
                sourceFilter: categorizedCompany.sourceFilter,
                discoveryQuery: categorizedCompany.discoveryQuery,
                category: categorizedCompany.category,
                relevanceScore: categorizedCompany.relevanceScore,
                rationale: categorizedCompany.rationale
              });
              historyQueue.enqueue({ type: "upsert-search", aggregate: { ...aggregate, decisionSamples: [...aggregate.decisionSamples] } });
            }
          }

          const aggregate = item.searchId ? searchAggregates.get(item.searchId) : undefined;
          const query = item.company.discoveryQuery?.trim();
          const queryStat = aggregate && query ? getOrCreateQueryStat(aggregate, query) : undefined;
          const scopeFilter = aggregate?.filter ?? defaultScopeFilter;

          if (
            targetCategories.includes(categorizedCompany.category as SelectableLeadCategory)
            && await isCompanyInScope(categorizedCompany, scopeFilter)
            && hasTrustedRegionSignal(categorizedCompany)
          ) {
            if (queryStat) {
              queryStat.accepted += 1;
              queryStat.categoryBreakdown[categorizedCompany.category] += 1;
              this.updateRecentLiveQueryHistory(currentRunQueryHistory, query, queryStat);
              updateLiveSearchDebug(aggregate, query ? { lastExecutedQuery: query } : {});
            }
            queueQualifiedCompany(categorizedCompany, "exa", item.searchId);
          } else if (targetCategories.includes(categorizedCompany.category as SelectableLeadCategory)) {
            metrics.aiRejectedDifferentCategory += 1;
            if (queryStat) {
              queryStat.rejectedDifferentCategory += 1;
              queryStat.categoryBreakdown[categorizedCompany.category] += 1;
              this.updateRecentLiveQueryHistory(currentRunQueryHistory, query, queryStat);
              updateLiveSearchDebug(aggregate, query ? { lastExecutedQuery: query } : {});
            }
            log(`Nicht-Zieltreffer wird aussortiert: ${categorizedCompany.name} (out_of_scope)`);
          } else if (categorizedCompany.category === "other") {
            metrics.aiRejectedOther += 1;
            if (queryStat) {
              queryStat.rejectedOther += 1;
              queryStat.categoryBreakdown.other += 1;
              this.updateRecentLiveQueryHistory(currentRunQueryHistory, query, queryStat);
              updateLiveSearchDebug(aggregate, query ? { lastExecutedQuery: query } : {});
            }
            queueNonTargetCompanyForCreation(categorizedCompany, "exa", item.searchId);
          } else {
            metrics.aiRejectedDifferentCategory += 1;
            if (queryStat) {
              queryStat.rejectedDifferentCategory += 1;
              queryStat.categoryBreakdown[categorizedCompany.category] += 1;
              this.updateRecentLiveQueryHistory(currentRunQueryHistory, query, queryStat);
              updateLiveSearchDebug(aggregate, query ? { lastExecutedQuery: query } : {});
            }
            queueNonTargetCompanyForCreation(categorizedCompany, "exa", item.searchId);
          }
        } catch (error) {
          metrics.aiRejectedOther += 1;
          const aggregate = item.searchId ? searchAggregates.get(item.searchId) : undefined;
          const query = item.company.discoveryQuery?.trim();
          if (aggregate && query) {
            const queryStat = getOrCreateQueryStat(aggregate, query);
            queryStat.rejectedOther += 1;
            queryStat.categoryBreakdown.other += 1;
            this.updateRecentLiveQueryHistory(currentRunQueryHistory, query, queryStat);
            updateLiveSearchDebug(aggregate, { lastExecutedQuery: query });
          }
          log(`KI-Worker Fehler fuer ${item.company.name}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          metrics.queueSizes.aiInFlight = Math.max(0, metrics.queueSizes.aiInFlight - 1);
          aiPendingCount = Math.max(0, aiPendingCount - 1);
          emitProgress();
        }
      }
    })());

    const outreachWorkers = Array.from({ length: outreachConcurrency }, () => (async () => {
      while (true) {
        const state = await outreachQueue.dequeue();
        if (!state) {
          break;
        }

        if (state.removed) {
          continue;
        }

        metrics.queueSizes.outreachInFlight += 1;
        state.outreachStatus = "running";
        emitProgress();
        try {
          let researchBriefTimeout: ReturnType<typeof setTimeout> | undefined;
          const researchBriefTimeoutPromise = new Promise<never>((_, reject) => {
            researchBriefTimeout = setTimeout(() => {
              reject(new Error(`Outreach worker timed out after ${RESEARCH_BRIEF_TASK_TIMEOUT_MS}ms`));
            }, RESEARCH_BRIEF_TASK_TIMEOUT_MS);
          });
          try {
            state.researchBrief = await Promise.race([
              this.debugConsoleService.buildResearchBriefForExecution(state.company),
              researchBriefTimeoutPromise
            ]);
          } finally {
            if (researchBriefTimeout) {
              clearTimeout(researchBriefTimeout);
            }
          }
          state.outreachStatus = "done";
          metrics.outreachCompleted += 1;
          log(`Outreach fertig: ${state.company.name}`);
          maybeQueueHubSpot(state);
        } catch (error) {
          state.outreachStatus = "failed";
          state.removed = true;
          state.pipelineAssigned = false;
          metrics.outreachFailed += 1;
          logError(`Outreach fehlgeschlagen, Firma entfernt: ${state.company.name}: ${error instanceof Error ? error.message : String(error)}`);
          maybePromoteStandby();
          screeningQueue.enqueue({
            type: "upsert",
            record: buildScreeningRecord(state.company)
          });
        } finally {
          metrics.queueSizes.outreachInFlight = Math.max(0, metrics.queueSizes.outreachInFlight - 1);
          emitProgress();
        }
      }
    })());

    const contactWorkers = Array.from({ length: contactConcurrency }, () => (async () => {
      while (true) {
        const state = await contactQueue.dequeue();
        if (!state) {
          break;
        }

        if (state.removed) {
          continue;
        }

        metrics.queueSizes.contactInFlight += 1;
        state.contactStatus = "running";
        emitProgress();
        try {
          let contactDebug: ContactDebugResult = { selectedContacts: [] } as ContactDebugResult;
          // Retry contact discovery only when an attempt actually FAILS (throws/times out). A
          // completed crawl that returns zero contacts is a valid terminal result - many sites
          // legitimately expose no public staff contacts - so we must not re-crawl them. Because
          // the browser is globally serialized, retrying on empty would multiply crawl cost and
          // starve the whole pipeline, so retries are reserved for genuine failures.
          let lastError: unknown;
          for (let attempt = 1; attempt <= CONTACT_DISCOVERY_MAX_ATTEMPTS; attempt += 1) {
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => {
                reject(new ContactWorkerTimeoutError(`Contact worker timed out after ${this.contactTaskTimeoutMs}ms`));
              }, this.contactTaskTimeoutMs);
            });

            try {
              contactDebug = await Promise.race<ContactDebugResult>([
                this.debugConsoleService.discoverContactsForExecution(state.company, {
                  selectedContactsTimeoutMs: 370_000
                }),
                timeoutPromise
              ]);
              lastError = undefined;
              break;
            } catch (attemptError) {
              lastError = attemptError;
              // A budget timeout already used its full window, so retrying it only re-blocks the
              // serialized browser for every other company; accept it immediately and let HubSpot
              // run without contacts. Only genuine transient failures are worth another attempt.
              if (attemptError instanceof ContactWorkerTimeoutError) {
                break;
              }
              if (attempt < CONTACT_DISCOVERY_MAX_ATTEMPTS) {
                log(`Kontaktsuche fehlgeschlagen fuer ${state.company.name} (Versuch ${attempt}/${CONTACT_DISCOVERY_MAX_ATTEMPTS}) - erneuter Versuch: ${attemptError instanceof Error ? attemptError.message : String(attemptError)}`);
                await delay(CONTACT_DISCOVERY_RETRY_DELAY_MS);
              }
            } finally {
              if (timeoutHandle) {
                clearTimeout(timeoutHandle);
              }
            }
          }

          if (lastError) {
            throw lastError;
          }

          state.contacts = contactDebug.selectedContacts ?? [];
          state.contactStatus = "done";
          metrics.contactCompleted += 1;
          log(`Kontakte fertig: ${state.company.name} (${state.contacts.length}) ${summarizeContactChannels(state.contacts)}`);
          maybeQueueHubSpot(state);
        } catch (error) {
          state.contactStatus = "failed";
          metrics.contactFailed += 1;
          state.contacts = [];
          logError(`Kontakt-Worker Fehler, HubSpot laeuft ohne Kontakte weiter: ${state.company.name}: ${error instanceof Error ? error.message : String(error)}`);
          maybeQueueHubSpot(state);
        } finally {
          metrics.queueSizes.contactInFlight = Math.max(0, metrics.queueSizes.contactInFlight - 1);
          emitProgress();
        }
      }
    })());

    const hubspotWorkers = Array.from({ length: hubspotConcurrency }, () => (async () => {
      while (true) {
        const state = await hubspotQueue.dequeue();
        if (!state) {
          break;
        }

        if (state.removed || state.hubspotStatus === "done") {
          continue;
        }

        // Authoritative locality hard-constraint gate. The qualification-time scope check runs on
        // the sourcing-time country, which is derived from a domain/snippet heuristic and can
        // mislabel non-European companies as in-scope. Before any HubSpot write, resolve the
        // company's real identity from its own website and re-evaluate scope on the AI-determined
        // country. The crawl is cached per domain (contact discovery already warmed it), so this
        // does not trigger a second full crawl. Locality is a hard constraint: a company whose
        // verified country is outside the target region must never be written.
        const resolveIdentity = (this.hubSpotClient as { resolveCompanyAddress?: unknown }).resolveCompanyAddress;
        const resolverAvailable = typeof resolveIdentity === "function";
        let countryVerifiedFromWebsite = false;
        if (resolverAvailable) {
          let identityTimeout: ReturnType<typeof setTimeout> | undefined;
          const resolvedIdentity = await Promise.race([
            this.hubSpotClient.resolveCompanyAddress(state.company),
            new Promise<null>((resolve) => {
              identityTimeout = setTimeout(() => resolve(null), IDENTITY_RESOLUTION_TIMEOUT_MS);
            })
          ]).catch(() => null);
          if (identityTimeout) {
            clearTimeout(identityTimeout);
          }
          const canonicalName = resolvedIdentity?.companyName?.trim();
          const canonicalCountry = resolvedIdentity?.country?.trim();
          // Only adopt the website-extracted name when it is a plausible company name. A blocked
          // crawl returns anti-bot challenge text ("sorry, but your current behavior is detected
          // as...") and prose fragments; adopting those would overwrite the sourcing name with a
          // meaningless label that then leaks into HubSpot and outreach.
          if (canonicalName && isPlausibleCompanyName(canonicalName)) {
            state.company.name = canonicalName;
          }
          if (canonicalCountry) {
            state.company.country = canonicalCountry;
            countryVerifiedFromWebsite = true;
          }
        }
        // Fail CLOSED on locality. The sourcing-time country is a domain/snippet heuristic that is
        // only reliable for European country-code TLDs. For a neutral/global TLD (.com, .io, .ai,
        // ...) we must NOT trust the heuristic: a US/non-EU company whose website crawl timed out
        // (so its country could not be verified) would otherwise pass the scope fallback and leak
        // into HubSpot. When the identity resolver is wired (always in production), such a company
        // is written only when its country was positively verified from its own website AND that
        // Fail CLOSED on the scope FALLBACK path only. isCompanyInScope returns true in three ways:
        // (1) a non-empty country that is European, (2) an empty country on a European ccTLD, or
        // (3) the neutral fallback `filter.locations.every(isEuropean)` when the country is empty
        // AND the domain has a neutral/global TLD. Path (3) is the fail-open hole: a non-EU company
        // on a .com/.io with no resolved country leaks through. A NON-EMPTY country is evidence
        // based (assigned from a European ccTLD or from country/city evidence in the website/snippet
        // text by inferCountryFromDomain), so it is a trustworthy region signal on its own and must
        // NOT be dropped just because the browser identity crawl timed out under load (that was
        // discarding real German/Italian .com companies). Only when the country is empty do we
        // require positive verification — a European ccTLD or a website-verified country — to close
        // path (3). The !resolverAvailable escape keeps legacy/stub callers unchanged.
        const inScope = await isCompanyInScope({ country: state.company.country, domain: state.company.domain }, defaultScopeFilter);
        const hasResolvedCountry = (state.company.country ?? "").trim().length > 0;
        const trustedRegionSignal = !resolverAvailable
          || hasResolvedCountry
          || countryVerifiedFromWebsite
          || hasEuropeanTld(state.company.domain);
        if (!inScope || !trustedRegionSignal) {
          state.hubspotStatus = "skipped";
          state.removed = true;
          state.pipelineAssigned = false;
          metrics.hubspotSkippedOutOfScope += 1;
          const skipReason = inScope ? "Region nicht verifiziert" : "ausserhalb Zielregion";
          log(`HubSpot uebersprungen (${skipReason}): ${state.company.name} (${state.company.country ?? "unbekannt"})`);
          screeningQueue.enqueue({ type: "upsert", record: buildScreeningRecord(state.company) });
          maybePromoteStandby();
          emitProgress();
          continue;
        }

        // Fail CLOSED on the company NAME. When neither the sourcing name nor the domain's first
        // label yields a usable brand name, the HubSpot writer would fall back to the domain label
        // and create a junk record. For asset/UUID hosts (e.g. <uuid>.filesusr.com) that label is
        // a machine slug like "489f595f 6891 49a9 b5fc 6a83ba5b0317". Skip + screen such companies
        // instead of writing a numeric "company name".
        const domainFirstLabel = (state.company.domain ?? "")
          .replace(/^https?:\/\//i, "")
          .replace(/^www\./i, "")
          .split(/[./]/)[0] ?? "";
        const hasUsableCompanyName = isPlausibleCompanyName(state.company.name)
          || (Boolean(domainFirstLabel) && !looksLikeHexOrUuidSlug(domainFirstLabel));
        if (!hasUsableCompanyName) {
          state.hubspotStatus = "skipped";
          state.removed = true;
          state.pipelineAssigned = false;
          metrics.hubspotSkippedOutOfScope += 1;
          log(`HubSpot uebersprungen (kein brauchbarer Firmenname): ${state.company.name} | ${state.company.domain ?? "ohne Domain"}`);
          screeningQueue.enqueue({ type: "upsert", record: buildScreeningRecord(state.company) });
          maybePromoteStandby();
          emitProgress();
          continue;
        }

        metrics.queueSizes.hubspotInFlight += 1;
        state.hubspotStatus = "running";
        log(`HubSpot startet: ${state.company.name} | ${summarizeContactChannels(state.contacts)}`);
        emitProgress();
        try {
          // Generate an INDIVIDUAL outreach message per contact from the company's website evidence,
          // using the ONE WARE outreach agent prompt (data/outreach-context.md). The company-level
          // research brief is kept for rankings/business potential/company fields; this only writes
          // a per-person message that the HubSpot note builder prefers. A per-contact generation
          // failure or timeout never blocks the write: that contact simply falls back to the brief.
          if (Array.isArray(state.contacts) && state.contacts.length > 0) {
            await Promise.all(
              state.contacts.map(async (contact) => {
                try {
                  const personalizedOutreach = await Promise.race([
                    this.debugConsoleService.generatePersonalizedOutreachForExecution(
                      state.company,
                      state.researchBrief,
                      {
                        firstName: contact.firstName,
                        lastName: contact.lastName,
                        jobTitle: contact.jobTitle,
                        linkedinUrl: contact.linkedinUrl
                      }
                    ),
                    new Promise<null>((resolve) =>
                      setTimeout(() => resolve(null), PERSONALIZED_OUTREACH_PER_CONTACT_TIMEOUT_MS)
                    )
                  ]);
                  if (personalizedOutreach) {
                    contact.personalizedOutreach = personalizedOutreach;
                  }
                } catch (outreachError) {
                  log(`Personalisierter Outreach fehlgeschlagen (faellt auf Brief zurueck) fuer ${state.company.name}/${[contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.label}: ${outreachError instanceof Error ? outreachError.message : String(outreachError)}`);
                }
              })
            );
            const personalizedCount = state.contacts.filter((contact) => contact.personalizedOutreach).length;
            log(`Personalisierter Outreach erstellt: ${state.company.name} (${personalizedCount}/${state.contacts.length})`);
          }

          const companySyncKey = new URL(state.company.domain?.startsWith("http") ? state.company.domain : `https://${state.company.domain ?? state.company.name}`).hostname.replace(/^www\./i, "").toLowerCase();
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              reject(new Error(`HubSpot worker timed out after ${this.hubspotTaskTimeoutMs}ms`));
            }, this.hubspotTaskTimeoutMs);
          });

          let syncResult;
          try {
            syncResult = await Promise.race([
              this.hubSpotClient.syncQualifiedCompanies(
                [state.company],
                state.researchBrief ? [state.researchBrief] : [],
                new Map<string, PublicContactCandidate[]>([[companySyncKey, state.contacts]]),
                Boolean(request.dryRun || request.syncToHubSpot === false)
              ),
              timeoutPromise
            ]);
          } finally {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
          }
          // A company write is successful when the record was created OR updated.
          // companySyncedCount only counts NEW creations, so re-syncing a company that already
          // exists in HubSpot returns 0 there even though the upsert succeeded. successfulCompanyKeys
          // reflects created-or-updated writes; prefer it and fall back to companySyncedCount for
          // callers/tests that do not populate the keys, so a successful update is never mistaken
          // for a failure.
          const successfulCompanyWrites = Array.isArray(syncResult.successfulCompanyKeys) && syncResult.successfulCompanyKeys.length > 0
            ? syncResult.successfulCompanyKeys.length
            : (syncResult.companySyncedCount ?? 0);
          if (successfulCompanyWrites === 0) {
            const syncErrors = Array.isArray(syncResult.errors) ? syncResult.errors.filter(Boolean) : [];
            if (syncErrors.length > 0) {
              throw new Error(`HubSpot sync produced 0 company writes. ${syncErrors.slice(0, 3).join(" | ")}`);
            }

            throw new Error("HubSpot sync produced 0 company writes without explicit API errors.");
          }
          state.hubspotStatus = "done";
          state.pipelineAssigned = false;
          state.completedAt = new Date().toISOString();
          metrics.hubspotWritten += successfulCompanyWrites;
          const syncErrorCount = Array.isArray(syncResult.errors) ? syncResult.errors.length : 0;
          if (syncErrorCount > 0) {
            log(`HubSpot Sync Warnungen fuer ${state.company.name}: ${syncErrorCount}`);
          }
          if (hasReachedTarget()) {
            stopping = true;
          }
          screeningQueue.enqueue({ type: "remove", key: state.key });
          log(`HubSpot fertig: ${state.company.name} (companySynced=${successfulCompanyWrites}, contactSynced=${syncResult.contactSyncedCount})`);
          maybePromoteStandby();
        } catch (error) {
          state.hubspotStatus = "failed";
          state.removed = true;
          state.pipelineAssigned = false;
          state.hubspotError = error instanceof Error ? error.message : String(error);
          logError(`HubSpot Fehler fuer ${state.company.name}: ${state.hubspotError}`);
          maybePromoteStandby();
        } finally {
          metrics.queueSizes.hubspotInFlight = Math.max(0, metrics.queueSizes.hubspotInFlight - 1);
          emitProgress();
        }
      }
    })());

    const seedRecords = request.reuseQualifiedCompanyCache === false
      ? []
      : screeningDatabase.records.filter((record) => {
          if (record.existsInHubSpot) {
            return false;
          }
          if (!record.category || !targetCategories.includes(record.category as SelectableLeadCategory)) {
            return false;
          }
          return !record.sourceFilter?.includes("debug-stage=");
        }).slice(0, targetLeadCount);

    for (const record of seedRecords) {
      const sourceFilter = record.sourceFilter ?? `cached-live-category:${record.category}`;
      // Route every seed through the SAME website -> Azure AI classification path as fresh Exa
      // results (the aiQueue). That single AI check determines BOTH the category AND the
      // headquarters country from the company's own website, then applies the identical accept gate
      // (target category + isCompanyInScope + region-trust). This is the efficient, consistent
      // design: locality is decided where the category is decided, so an out-of-region or
      // region-unverifiable seed is dropped BEFORE it consumes outreach + contact discovery instead
      // of travelling the whole pipeline only to be skipped at the pre-write gate. It also
      // re-validates the cached category from the live website (AGENTS.md: do not trust cached
      // categorizations when a domain is available) and backfills the resolved country into the
      // screening record so the cache self-heals across runs.
      //
      // We deliberately do NOT seed a market-default country here: createManualCompanyForWebsite /
      // buildManualCompany default country to filters[0].locations[0] (e.g. "Germany"), and trusting
      // that default is exactly what wrote out-of-region seeds (Mapvision .fi, Chromos .ch,
      // Innerspec US, ...) into HubSpot as "Germany". Pass the persisted evidence-based country when
      // one exists, otherwise leave it empty so the classifier/identity resolver determines the real
      // country from the website.
      const company: CompanySample = {
        name: record.companyName,
        domain: record.domain,
        country: record.country?.trim() || undefined,
        shortDescription: record.shortDescription ?? "",
        sourceFilter
      };
      const key = buildCompanyKey(company);
      if (seenCompanyKeys.has(key)) {
        continue;
      }
      seenCompanyKeys.add(key);
      const normalizedDomain = normalizeDomain(company.domain);
      if (normalizedDomain) {
        currentRunExcludedDomains.add(normalizedDomain);
      }
      // See ingestRawCompanies: only count the pending AI task when enqueue actually accepts it, so a
      // closed queue (post-stop) never leaks aiPendingCount and strands the run in stage=stopping.
      if (aiQueue.enqueue({ company })) {
        aiPendingCount += 1;
      }
    }

    const exaWorkers = Array.from({ length: exaConcurrency }, () => (async () => {
      try {
      while (!stopping && Date.now() < deadlineMs && metrics.hubspotWritten < targetLeadCount) {
        maybePromoteStandby();
        if (neededCompanies() <= 0) {
          await delay(SEARCH_IDLE_MS);
          continue;
        }

        const filter = getNextSearchFilter();
        if (!filter) {
          stopReason = stopReason || "exa_search_unavailable";
          stopping = true;
          log("Alle Exa-Filter sind nach temporaeren Suchfehlern ausgeschieden. Bereits angenommene Firmen werden trotzdem fertig verarbeitet.");
          stopAiQueue();
          maybePromoteStandby();
          break;
        }

        const searchId = `worker-search-${searchCounter + 1}`;
        const aggregate: SearchAggregate = {
          id: searchId,
          filter,
          page: searchCounter + 1,
          requestedCount: SEARCH_BATCH_SIZE,
          executedQueries: 0,
          queryTexts: [],
          rawFound: 0,
          categoryBreakdown: createEmptyCategoryBreakdown(),
          queryStats: [],
          decisionSamples: []
        };
        searchAggregates.set(searchId, aggregate);
        metrics.exaBatchesStarted += 1;
        searchCounter += 1;
        metrics.queueSizes.exaInFlight += 1;
        log(`Exa-Worker startet Batch ${searchId} fuer ${filter.name}`);

        try {
          const pendingPlanKey = filter.name;
          const pendingPlan = pendingExaQueryPlans.get(pendingPlanKey);
          const forcedQueries = pendingPlan?.remainingQueries.slice(0, exaQueryCount) ?? [];
          const usingPendingQueryPlan = forcedQueries.length > 0;
          let plannedDefaultQueries: string[] | undefined;
          let plannedPromptMessages: Array<{ role: string; content: string }> | undefined;
          let receivedStreamedRawCompanies = false;
          const exaDiscoveryTimeoutMs = getExaDiscoveryTimeoutMs(exaQueryCount);

          let exaTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const exaTimeoutPromise = new Promise<never>((_, reject) => {
            exaTimeoutHandle = setTimeout(() => {
              reject(new Error(`Exa discovery timed out after ${exaDiscoveryTimeoutMs}ms`));
            }, exaDiscoveryTimeoutMs);
          });

          let rawCompanies: CompanySample[];
          try {
            rawCompanies = await Promise.race<CompanySample[]>([
              this.leadPipelineAgent.discoverDirectExaCompaniesForExecution(
                filter,
                targetCategories,
                exaQueryCount,
                {
                  screeningScope: "live",
                  currentRunExcludedDomains: Array.from(currentRunExcludedDomains)
                },
                {
                  dryRun: request.dryRun,
                  learning,
                  mainContext: request.mainContext,
                  searchStrategyContext: request.searchStrategyContext,
                  recentQueryHistory: Array.from(currentRunQueryHistory.values()),
                  prequalification: request.prequalification,
                  exaSearchMode: request.exaSearchMode,
                  forcedQueries: usingPendingQueryPlan ? forcedQueries : undefined,
                  plannedQueryMetadata: usingPendingQueryPlan
                    ? {
                        defaultQueries: pendingPlan?.defaultQueries,
                        plannedQueries: pendingPlan?.plannedQueries,
                        promptMessages: pendingPlan?.promptMessages
                      }
                    : undefined
                },
                (update) => {
                  const previousReturnedResults = aggregate.returnedResults ?? 0;
                  const previousFilteredByExcludedDomains = aggregate.filteredByExcludedDomains ?? 0;
                  const previousFilteredByHubSpot = aggregate.filteredByHubSpot ?? 0;
                  const previousFilteredByRejectedWebsites = aggregate.filteredByRejectedWebsites ?? 0;
                  const previousFilteredByCurrentRunCache = aggregate.filteredByCurrentRunCache ?? 0;
                  const previousDuplicatesRemoved = aggregate.duplicatesRemoved ?? 0;
                  const previousExecutedQueries = aggregate.executedQueries;
                  const nextReturnedResults = update.returnedResults ?? previousReturnedResults;
                  const nextFilteredByExcludedDomains = update.filteredByExcludedDomains ?? previousFilteredByExcludedDomains;
                  const nextFilteredByHubSpot = update.filteredByHubSpot ?? previousFilteredByHubSpot;
                  const nextFilteredByRejectedWebsites = update.filteredByRejectedWebsites ?? previousFilteredByRejectedWebsites;
                  const nextFilteredByCurrentRunCache = update.filteredByCurrentRunCache ?? previousFilteredByCurrentRunCache;
                  const nextDuplicatesRemoved = update.duplicatesRemoved ?? previousDuplicatesRemoved;
                  plannedDefaultQueries = update.defaultQueries;
                  plannedPromptMessages = update.promptMessages;
                  aggregate.executedQueries = update.executedQueries;
                  metrics.exaRequests += Math.max(0, update.executedQueries - previousExecutedQueries);
                  metrics.exaDuplicatesRemoved += Math.max(0, nextDuplicatesRemoved - previousDuplicatesRemoved);
                  aggregate.rawFound = update.rawCompaniesFound;
                  const queryStat = getOrCreateQueryStat(aggregate, update.query);
                  queryStat.returnedResults += Math.max(0, nextReturnedResults - previousReturnedResults);
                  queryStat.filteredByExcludedDomains += Math.max(0, nextFilteredByExcludedDomains - previousFilteredByExcludedDomains);
                  queryStat.filteredByHubSpot += Math.max(0, nextFilteredByHubSpot - previousFilteredByHubSpot);
                  queryStat.filteredByRejectedWebsites += Math.max(0, nextFilteredByRejectedWebsites - previousFilteredByRejectedWebsites);
                  queryStat.filteredByCurrentRunCache += Math.max(0, nextFilteredByCurrentRunCache - previousFilteredByCurrentRunCache);
                  queryStat.duplicates += Math.max(0, nextDuplicatesRemoved - previousDuplicatesRemoved);
                  queryStat.rawFound += update.newRawCompanies?.length ?? 0;
                  aggregate.queryTexts.push(update.query);
                  aggregate.plannedQueries = update.plannedQueries;
                  aggregate.promptMessages = update.promptMessages;
                  aggregate.excludedDomains = update.excludedDomains;
                  aggregate.excludedDomainDetails = update.excludedDomainDetails;
                  aggregate.returnedResults = nextReturnedResults;
                  aggregate.filteredByExcludedDomains = nextFilteredByExcludedDomains;
                  aggregate.filteredByHubSpot = nextFilteredByHubSpot;
                  aggregate.filteredByRejectedWebsites = nextFilteredByRejectedWebsites;
                  aggregate.filteredByCurrentRunCache = nextFilteredByCurrentRunCache;
                  aggregate.duplicatesRemoved = nextDuplicatesRemoved;
                  updateLiveSearchDebug(aggregate, {
                    filterName: update.filterName,
                    defaultQueries: update.defaultQueries,
                    plannedQueries: update.plannedQueries,
                    promptMessages: update.promptMessages,
                    lastExecutedQuery: update.query,
                    excludedDomains: update.excludedDomains,
                    executedQueries: update.executedQueries,
                    totalQueries: update.totalQueries,
                    returnedResults: update.returnedResults,
                    filteredByExcludedDomains: update.filteredByExcludedDomains,
                    filteredByHubSpot: update.filteredByHubSpot,
                    filteredByRejectedWebsites: update.filteredByRejectedWebsites,
                    filteredByCurrentRunCache: update.filteredByCurrentRunCache,
                    duplicatesRemoved: update.duplicatesRemoved,
                    rawCompaniesFound: update.rawCompaniesFound
                  });
                  if (!currentRunQueryHistory.has(update.query)) {
                    currentRunQueryHistory.set(update.query, {
                      query: update.query,
                      timestamp: new Date().toISOString(),
                      foundCategoryBreakdown: createEmptyCategoryBreakdown()
                    });
                  }
                  historyQueue.enqueue({ type: "upsert-search", aggregate: { ...aggregate, queryTexts: [...aggregate.queryTexts] } });
                  if (Array.isArray(update.newRawCompanies) && update.newRawCompanies.length > 0) {
                    receivedStreamedRawCompanies = true;
                    ingestRawCompanies(update.newRawCompanies, searchId);
                  }
                  emitProgress();
                }
              ),
              exaTimeoutPromise
            ]);
          } finally {
            if (exaTimeoutHandle) {
              clearTimeout(exaTimeoutHandle);
            }
          }

          if (usingPendingQueryPlan) {
            const remainingQueries = pendingPlan?.remainingQueries.slice(forcedQueries.length) ?? [];
            if (remainingQueries.length > 0 && pendingPlan) {
              pendingExaQueryPlans.set(pendingPlanKey, {
                ...pendingPlan,
                remainingQueries
              });
            } else {
              pendingExaQueryPlans.delete(pendingPlanKey);
            }
          } else {
            const plannedQueries = Array.from(new Set((aggregate.plannedQueries ?? []).map((query) => query.trim()).filter(Boolean)));
            const remainingQueries = plannedQueries.slice(exaQueryCount);
            if (remainingQueries.length > 0) {
              pendingExaQueryPlans.set(pendingPlanKey, {
                remainingQueries,
                plannedQueries,
                defaultQueries: plannedDefaultQueries,
                promptMessages: plannedPromptMessages
              });
            } else {
              pendingExaQueryPlans.delete(pendingPlanKey);
            }
          }

          metrics.exaReturnedResults += aggregate.returnedResults ?? 0;
          metrics.exaFilteredByExcludedDomains += aggregate.filteredByExcludedDomains ?? 0;
          let uniqueRawCompanies: CompanySample[];
          if (receivedStreamedRawCompanies) {
            // These companies were already ingested (and any duplicates already counted) while the
            // search was streaming results. Re-running ingestion here must not re-count them as duplicates.
            uniqueRawCompanies = ingestRawCompanies(rawCompanies, searchId, { countDuplicates: false });
          } else {
            uniqueRawCompanies = [];
            for (const company of rawCompanies) {
              const query = company.discoveryQuery?.trim();
              if (query) {
                getOrCreateQueryStat(aggregate, query).rawFound += 1;
              }
              const key = buildCompanyKey(company);
              if (seenCompanyKeys.has(key)) {
                if (query) {
                  getOrCreateQueryStat(aggregate, query).duplicates += 1;
                }
                metrics.exaDuplicatesRemoved += 1;
                continue;
              }

              const ingestedCompanies = ingestRawCompanies([company], searchId);
              if (ingestedCompanies.length > 0) {
                uniqueRawCompanies.push(ingestedCompanies[0]);
              }
            }
          }

          aggregate.rawFound = Math.max(aggregate.rawFound ?? 0, uniqueRawCompanies.length);
          aggregate.returnedResults = aggregate.queryStats.reduce((sum, queryStat) => sum + queryStat.returnedResults, 0);
          aggregate.filteredByExcludedDomains = aggregate.queryStats.reduce((sum, queryStat) => sum + queryStat.filteredByExcludedDomains, 0);
          aggregate.duplicatesRemoved = aggregate.queryStats.reduce((sum, queryStat) => sum + queryStat.duplicates, 0);
          historyQueue.enqueue({ type: "upsert-search", aggregate: { ...aggregate, queryTexts: [...new Set(aggregate.queryTexts)] } });
          await flushBufferedLiveRawCompanies();

          const persistedQueryTexts = [...new Set(aggregate.queryTexts.map((query) => query.trim()).filter(Boolean))];
          if (persistedQueryTexts.length > 0) {
            const queryStatByText = new Map(
              aggregate.queryStats.map((queryStat) => [queryStat.query.trim(), queryStat])
            );
            await this.controlPlaneStore.recordLiveExaQueryRuns(
              persistedQueryTexts.map((query) => {
                const queryStat = queryStatByText.get(query);
                return {
                  timestamp: new Date().toISOString(),
                  filterName: aggregate.filter.name,
                  query,
                  plannedQueries: aggregate.plannedQueries,
                  promptMessages: aggregate.promptMessages,
                  excludedDomains: aggregate.excludedDomains,
                  excludedDomainDetails: aggregate.excludedDomainDetails,
                  queryStats: queryStat
                    ? {
                        rawFound: queryStat.rawFound,
                        duplicates: queryStat.duplicates,
                        accepted: queryStat.accepted,
                        rejectedDifferentCategory: queryStat.rejectedDifferentCategory,
                        rejectedOther: queryStat.rejectedOther,
                        filteredByHubSpot: queryStat.filteredByHubSpot,
                        filteredByRejectedWebsites: queryStat.filteredByRejectedWebsites,
                        filteredByCurrentRunCache: queryStat.filteredByCurrentRunCache,
                        categoryBreakdown: { ...queryStat.categoryBreakdown }
                      }
                    : undefined
                };
              })
            );
          }
          temporarilyUnavailableFilters.delete(filter.name);
          emitProgress();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (this.isExaCreditsExhaustedError(errorMessage) || this.isExaTemporarilyUnavailableError(error)) {
            if (this.isExaCreditsExhaustedError(errorMessage)) {
              stopReason = stopReason || "exa_credits_exhausted";
              stopping = true;
              log(`Exa-Suche gestoppt. Bereits angenommene Firmen werden trotzdem fertig verarbeitet. (${errorMessage})`);
              await flushBufferedLiveRawCompanies();
              stopAiQueue();
              maybePromoteStandby();
              break;
            }

            temporarilyUnavailableFilters.add(filter.name);
            hadTemporaryExaFailure = true;
            log(`Exa-Batch fuer ${filter.name} fehlgeschlagen. Worker versucht mit den uebrigen Filtern weiterzumachen. (${errorMessage})`);
            await flushBufferedLiveRawCompanies();
            if (temporarilyUnavailableFilters.size >= filters.length) {
              stopReason = stopReason || "exa_search_unavailable";
              stopping = true;
              log("Alle Exa-Filter sind nach temporaeren Suchfehlern ausgeschieden. Bereits angenommene Firmen werden trotzdem fertig verarbeitet.");
              stopAiQueue();
              maybePromoteStandby();
              break;
            }

            continue;
          }

          throw error;
        } finally {
          metrics.queueSizes.exaInFlight = Math.max(0, metrics.queueSizes.exaInFlight - 1);
          emitProgress();
        }
      }
      } catch (error) {
        // A fatal error in one exa worker must never strand the whole run. If a worker threw
        // (e.g. the re-thrown non-Exa error above) without counting toward completion,
        // completedExaWorkers would stay below the worker count, searchCompleted would never
        // flip to true, and the finalization loop would spin forever with idle queues. Log it
        // and let the finally below mark this worker done so the run can finalize gracefully.
        logError(`Exa-Worker abgebrochen: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        completedExaWorkers += 1;
        if (completedExaWorkers >= exaWorkers.length) {
          searchCompleted = true;
          aiQueue.close();
          emitProgress();
        }
      }
    })());

    const abortHandler = () => {
      stopping = true;
      stopReason = stopReason || "manually_stopped";
      log("Stop angefordert. Neue Exa- und KI-Aufgaben werden nicht mehr gestartet.");
      stopAiQueue();
    };
    options.signal?.addEventListener("abort", abortHandler);

    const screeningWorkerPromise = screeningWorker();
    const historyWorkerPromise = historyWorker();

    emitProgress();

    try {
      while (true) {
        if (!stopping && Date.now() >= deadlineMs) {
          timedOut = true;
          stopping = true;
          stopReason = "runtime_limit_reached";
          log("Zeitlimit erreicht. Exa startet keine neuen Suchen mehr. Alle bereits gefundenen Firmen werden noch analysiert, mit Kontakten/Outreach angereichert und in HubSpot geschrieben, bevor der Lauf stoppt.");
          stopAiQueue();
        }

        if (metrics.hubspotWritten >= targetLeadCount) {
          stopReason = stopReason || "target_reached";
          stopping = true;
          stopAiQueue();
        }

        // While finishing, keep draining the standby list into the active pipeline. After a runtime
        // timeout the AI workers still classify the companies Exa already returned; those qualified
        // companies land on standby and must be promoted here so every already-found company is
        // analyzed, enriched with contacts/outreach and written to HubSpot before the run ends.
        // maybePromoteStandby itself respects the target cap, so this never overshoots the target.
        // Any standby left after this call is intentionally non-promotable (target already reached),
        // so the break below must NOT wait on standbyQualifiedStates being empty or it would hang.
        maybePromoteStandby();

        if (stopping && countAiPending() === 0 && countDownstreamInFlight() === 0) {
          break;
        }

        if (!stopping && searchCompleted && countAiPending() === 0 && countDownstreamInFlight() === 0 && standbyQualifiedStates.length === 0) {
          break;
        }

        // Keep the run status fresh while waiting on external worker calls.
        emitProgress();
        await delay(SEARCH_IDLE_MS);
      }

      // Bounded shutdown drain. All leads are already written to HubSpot inline; the steps below
      // only join already-idle worker promises and flush the internal screening/search-history
      // caches. A single hung cleanup worker previously froze the run in stage=stopping for 16 min
      // (updatedAt stopped advancing because nothing in this block calls emitProgress). Run the
      // drain against a hard deadline with a heartbeat so the run always reaches a terminal state
      // and the UI keeps updating; anything still pending after the deadline is internal bookkeeping
      // that is safe to abandon.
      const drainAll = (async () => {
        await Promise.all(exaWorkers);
        outreachQueue.close();
        contactQueue.close();
        await Promise.all(aiWorkers);
        await Promise.all(outreachWorkers);
        await Promise.all(contactWorkers);
        hubspotQueue.close();
        await Promise.all(hubspotWorkers);

        const remainingQualifiedStates = Array.from(qualifiedStates.values())
          .filter((state) => !state.removed && state.hubspotStatus !== "done");

        for (const state of remainingQualifiedStates) {
          screeningQueue.enqueue({
            type: "upsert",
            record: buildScreeningRecord(state.company)
          });
        }

        historyQueue.enqueue({ type: "flush" });
        await delay(SCREENING_FLUSH_DEBOUNCE_MS);
        screeningQueue.close();
        historyQueue.close();
        await Promise.all([screeningWorkerPromise, historyWorkerPromise]);
      })();

      const shutdownHeartbeat = setInterval(() => emitProgress(), SHUTDOWN_HEARTBEAT_MS);
      let drainDeadlineHandle: ReturnType<typeof setTimeout> | undefined;
      const drainDeadline = new Promise<void>((resolve) => {
        drainDeadlineHandle = setTimeout(() => {
          logError(`Shutdown-Drain hat ${SHUTDOWN_DRAIN_DEADLINE_MS}ms ueberschritten - Lauf wird beendet. Alle Leads sind bereits in HubSpot geschrieben; ein haengender Cleanup-Worker (Screening-/History-Flush) wird abgebrochen.`);
          resolve();
        }, SHUTDOWN_DRAIN_DEADLINE_MS);
      });
      try {
        await Promise.race([drainAll, drainDeadline]);
      } finally {
        clearInterval(shutdownHeartbeat);
        if (drainDeadlineHandle) {
          clearTimeout(drainDeadlineHandle);
        }
      }
    } finally {
      options.signal?.removeEventListener("abort", abortHandler);
    }

    if (screeningFlushDue) {
      let flushTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const flushTimeout = new Promise<void>((resolve) => {
        flushTimeoutHandle = setTimeout(() => {
          logError(`Abschliessender Screening-Flush hat ${SHUTDOWN_DRAIN_DEADLINE_MS}ms ueberschritten - wird uebersprungen.`);
          resolve();
        }, SHUTDOWN_DRAIN_DEADLINE_MS);
      });
      try {
        await Promise.race([
          this.controlPlaneStore.writeCompanyScreeningDatabase(screeningState),
          flushTimeout
        ]);
      } finally {
        if (flushTimeoutHandle) {
          clearTimeout(flushTimeoutHandle);
        }
      }
    }

    const searchHistory = Array.from(searchAggregates.values())
      .sort((left, right) => left.page - right.page)
      .map((aggregate) => {
        const relevantCount = targetCategories.reduce((count, category) => count + (aggregate.categoryBreakdown[category] ?? 0), 0);
        const returnedCount = Math.max(aggregate.rawFound, aggregate.decisionSamples.length);
        return {
          timestamp: new Date().toISOString(),
          companySearchMode: "exa_search",
          filterName: aggregate.filter.name,
          filterSnapshot: {
            persona: aggregate.filter.persona,
            industries: [...aggregate.filter.industries],
            keywords: [...aggregate.filter.keywords],
            locations: [...aggregate.filter.locations],
            employeeRanges: [...aggregate.filter.employeeRanges],
            notes: aggregate.filter.notes
          },
          targetCategory: aggregate.filter.targetCategories?.[0],
          batchType: "expand_50",
          page: aggregate.page,
          requestedCount: aggregate.requestedCount,
          returnedCount,
          relevantCount,
          relevanceRatio: returnedCount > 0 ? relevantCount / returnedCount : 0,
          categoryBreakdown: aggregate.categoryBreakdown,
          passedThreshold: relevantCount > 0,
          recommendation: relevantCount > 0 ? "keep-searching" : "broaden-query",
          fetchedSampleCount: aggregate.rawFound,
          eligibleSampleCount: relevantCount,
          discoveryQueries: [...new Set(aggregate.queryTexts)],
          plannedQueries: aggregate.plannedQueries,
          promptMessages: aggregate.promptMessages,
          excludedDomains: aggregate.excludedDomains,
          decisionSamples: aggregate.decisionSamples.slice(0, 10)
        } satisfies SearchHistoryEntry;
      });

    const completedStates = Array.from(qualifiedStates.values())
      .filter((state) => !state.removed && state.researchBrief)
      .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? ""));

    const shortlistedCompanies = completedStates.map((state) => state.company);
    const researchBriefs = completedStates.map((state) => state.researchBrief).filter((brief): brief is ResearchBrief => Boolean(brief));
    const generatedRecords = completedStates.map((state) => toGeneratedLeadRecord(state));
    const syncErrors = completedStates.map((state) => state.hubspotError).filter((value): value is string => Boolean(value));

    const result: LeadJobResult = {
      requested: request,
      suggestedFilters: filters,
      evaluations: [],
      shortlistedCompanies,
      researchBriefs,
      searchHistory,
      hubspotSync: {
        attempted: true,
        mode: request.dryRun || request.syncToHubSpot === false ? "dry-run" : "live",
        candidateCount: completedStates.length,
        syncedCount: metrics.hubspotWritten,
        companySyncedCount: metrics.hubspotWritten,
        contactSyncedCount: completedStates.reduce((count, state) => count + state.contacts.length, 0),
        errors: syncErrors.length > 0 ? syncErrors : undefined
      },
      efficiency: {
        filtersStoppedEarly: 0,
        companiesSkippedAfterEarlyStop: 0
      },
      funnel: {
        crawledPages: 0,
        afterCrawlerPrefilter: metrics.exaRawFound,
        afterHubSpotDedup: completedStates.length,
        afterAzureAICheck: metrics.aiAccepted,
        syncedToHubSpot: metrics.hubspotWritten
      },
      timedOut,
      stopped: stopReason === "manually_stopped",
      completionReason: stopReason || (metrics.hubspotWritten >= targetLeadCount
        ? "target_reached"
        : hadTemporaryExaFailure
          ? "exa_search_unavailable"
          : "search_exhausted"),
      costs: undefined
    };

    if (errorMessages.length > 0) {
      try {
        await this.controlPlaneStore.appendRunErrors(
          errorMessages.map((message) => ({
            timestamp: new Date().toISOString(),
            scope: "worker_run",
            message
          }))
        );
      } catch (persistError) {
        log(`Fehler beim Speichern der Run-Fehler: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
      }
    }

    await this.controlPlaneStore.writeLatestLeadRun({
      createdAt: new Date().toISOString(),
      requested: request,
      summary: {
        foundCandidates: generatedRecords.length,
        filtersTested: metrics.exaRequests,
        filtersStoppedEarly: 0,
        companiesSkippedAfterEarlyStop: 0,
        funnel: result.funnel,
        timedOut,
        stopped: stopReason === "manually_stopped",
        completionReason: result.completionReason
      },
      contacts: generatedRecords,
      searchHistory,
      hubspotSync: result.hubspotSync,
      costs: undefined
    });

    emitProgress();
    return result;
  }

  private buildRecentLiveExaQueryHistory(learning?: LeadLearningData): Array<[string, ExaQueryHistoryInsight]> {
    const recentEntries = (learning?.searchHistoryByMode?.exa_search?.searchHistory ?? [])
      .slice()
      .sort((left: SearchHistoryEntry, right: SearchHistoryEntry) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime())
      .slice(0, 12);
    const history = new Map<string, ExaQueryHistoryInsight>();

    for (const entry of recentEntries) {
      for (const queryStat of entry.queryStats ?? []) {
        const query = queryStat.query?.trim();
        if (!query || history.has(query)) {
          continue;
        }

        history.set(query, {
          query,
          timestamp: entry.timestamp,
          foundCategoryBreakdown: { ...queryStat.categoryBreakdown },
          returnedResults: queryStat.returnedResults,
          filteredByExcludedDomains: queryStat.filteredByExcludedDomains,
          rawFound: queryStat.rawFound,
          duplicates: queryStat.duplicates,
          accepted: queryStat.accepted,
          rejectedDifferentCategory: queryStat.rejectedDifferentCategory,
          rejectedOther: queryStat.rejectedOther,
          note: entry.filterName
        });
      }
    }

    return Array.from(history.entries());
  }

  private updateRecentLiveQueryHistory(
    history: Map<string, ExaQueryHistoryInsight>,
    query: string | undefined,
    queryStat: {
      categoryBreakdown: Record<LeadCategory, number>;
      returnedResults: number;
      filteredByExcludedDomains: number;
      rawFound: number;
      duplicates: number;
      accepted: number;
      rejectedDifferentCategory: number;
      rejectedOther: number;
    }
  ): void {
    const normalizedQuery = query?.trim();
    if (!normalizedQuery) {
      return;
    }

    const existing = history.get(normalizedQuery);
    history.set(normalizedQuery, {
      query: normalizedQuery,
      timestamp: existing?.timestamp ?? new Date().toISOString(),
      foundCategoryBreakdown: { ...queryStat.categoryBreakdown },
      returnedResults: queryStat.returnedResults,
      filteredByExcludedDomains: queryStat.filteredByExcludedDomains,
      rawFound: queryStat.rawFound,
      duplicates: queryStat.duplicates,
      accepted: queryStat.accepted,
      rejectedDifferentCategory: queryStat.rejectedDifferentCategory,
      rejectedOther: queryStat.rejectedOther,
      note: existing?.note
    });
  }

  private isExaCreditsExhaustedError(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes("no_more_credits")
      || normalized.includes("exceeded your credits limit")
      || (normalized.includes("exa") && normalized.includes("credits"));
  }

  private isExaTemporarilyUnavailableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    const errorName = error instanceof Error ? error.name.toLowerCase() : "";
    return normalized.includes("exa discovery timed out")
      || normalized.includes("operation was aborted due to timeout")
      || normalized.includes("the operation was aborted")
      || errorName === "aborterror"
      || errorName === "timeouterror"
      || (normalized.includes("exa") && normalized.includes("operation was aborted"))
      || (normalized.includes("exa") && normalized.includes("timed out"))
      || (normalized.includes("exa") && normalized.includes("429"))
      || (normalized.includes("exa") && normalized.includes("503"));
  }
}

function getOrCreateQueryStat(aggregate: SearchAggregate, query: string) {
  const existing = aggregate.queryStats.find((entry) => entry.query === query);
  if (existing) {
    return existing;
  }

  const created = {
    query,
    returnedResults: 0,
    filteredByExcludedDomains: 0,
    filteredByHubSpot: 0,
    filteredByRejectedWebsites: 0,
    filteredByCurrentRunCache: 0,
    rawFound: 0,
    duplicates: 0,
    accepted: 0,
    rejectedDifferentCategory: 0,
    rejectedOther: 0,
    categoryBreakdown: createEmptyCategoryBreakdown()
  };
  aggregate.queryStats.push(created);
  return created;
}