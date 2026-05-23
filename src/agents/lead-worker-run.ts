import { ControlPlaneStore } from "../control-plane.js";
import { DebugConsoleService } from "../debug/test-console-service.js";
import { HubSpotClient } from "../clients/hubspot.js";
import { LeadPipelineAgent } from "./lead-pipeline.js";
import type {
  ApolloOrganizationFilter,
  CompanySample,
  CompanyScreeningDatabase,
  CompanyScreeningRecord,
  GeneratedLeadRecord,
  LeadCategory,
  LeadJobRequest,
  LeadJobResult,
  LeadRunProgress,
  PreCategorizedCompany,
  PublicContactCandidate,
  ResearchBrief,
  SearchHistoryDecisionSample,
  SearchHistoryEntry,
  SelectableLeadCategory
} from "../types.js";

type ContactDebugResult = Awaited<ReturnType<DebugConsoleService["discoverContactsForExecution"]>>;

type QueueName = "exa" | "ai" | "outreach" | "contact" | "hubspot" | "screening" | "history";

interface WorkerRunMetrics {
  exaRequests: number;
  exaRawFound: number;
  aiAccepted: number;
  aiRejectedDifferentCategory: number;
  aiRejectedOther: number;
  outreachCompleted: number;
  outreachFailed: number;
  contactCompleted: number;
  contactFailed: number;
  hubspotWritten: number;
  queueSizes: {
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
  filter: ApolloOrganizationFilter;
  page: number;
  requestedCount: number;
  executedQueries: number;
  queryTexts: string[];
  rawFound: number;
  categoryBreakdown: Record<LeadCategory, number>;
  decisionSamples: SearchHistoryDecisionSample[];
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
}

class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(item: T | undefined) => void> = [];
  private closed = false;

  enqueue(item: T): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return;
    }

    this.items.push(item);
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

  get size(): number {
    return this.items.length;
  }
}

const SEARCH_BATCH_SIZE = 20;
const SEARCH_RESULT_HEADROOM = 4;
const SEARCH_IDLE_MS = 250;
const SCREENING_FLUSH_DEBOUNCE_MS = 500;
const DEBUG_MESSAGE_LIMIT = 60;
const DEFAULT_CONTACT_TASK_TIMEOUT_MS = 150_000;

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

function buildCompanyKey(company: { domain?: string; name: string }): string {
  return normalizeDomain(company.domain) ?? company.name.trim().toLowerCase();
}

function toCompanyWebsite(domain?: string): string | undefined {
  const normalized = normalizeDomain(domain);
  return normalized ? `https://${normalized}` : undefined;
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

  constructor(dependencies: LeadWorkerRunDependencies = {}) {
    this.controlPlaneStore = dependencies.controlPlaneStore ?? new ControlPlaneStore();
    this.debugConsoleService = dependencies.debugConsoleService ?? new DebugConsoleService();
    this.hubSpotClient = dependencies.hubSpotClient ?? new HubSpotClient();
    this.leadPipelineAgent = dependencies.leadPipelineAgent ?? new LeadPipelineAgent();
    this.contactTaskTimeoutMs = Math.max(1_000, dependencies.contactTaskTimeoutMs ?? DEFAULT_CONTACT_TASK_TIMEOUT_MS);
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
    const aiConcurrency = Math.max(1, request.aiPrefilterConcurrency ?? 2);
    const outreachConcurrency = Math.max(1, request.outreachPrepConcurrency ?? 6);
    const contactConcurrency = Math.max(1, request.contactSearchConcurrency ?? 8);
    const exaQueryCount = Math.max(1, request.exaQueryCount ?? 1);
    const screeningDatabase = await this.controlPlaneStore.getCompanyScreeningDatabase();
    const filters = this.leadPipelineAgent.buildDirectExaFiltersForExecution(targetCategories, request.market);
    const liveExaCache = request.excludePreviouslyFoundExaDomains ? await this.controlPlaneStore.getLiveExaCache() : undefined;

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
    const seenCompanyKeys = new Set<string>();
    const excludedDomains = new Set<string>((liveExaCache?.discoveredDomains ?? []).map((domain) => normalizeDomain(domain)).filter((value): value is string => Boolean(value)));
    const metrics: WorkerRunMetrics = {
      exaRequests: 0,
      exaRawFound: 0,
      aiAccepted: 0,
      aiRejectedDifferentCategory: 0,
      aiRejectedOther: 0,
      outreachCompleted: 0,
      outreachFailed: 0,
      contactCompleted: 0,
      contactFailed: 0,
      hubspotWritten: 0,
      queueSizes: {
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
    let screeningFlushDue = false;

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

    const countHeldQualifiedStates = () => Array.from(qualifiedStates.values()).filter((state) => !state.removed && state.hubspotStatus !== "done").length;
    const countAssignedQualifiedStates = () => Array.from(qualifiedStates.values()).filter((state) => !state.removed && state.pipelineAssigned && state.hubspotStatus !== "done").length;
    const countDownstreamInFlight = () =>
      metrics.queueSizes.outreachInFlight + metrics.queueSizes.contactInFlight + metrics.queueSizes.hubspotInFlight + outreachQueue.size + contactQueue.size + hubspotQueue.size;
    const countAiPending = () => metrics.queueSizes.aiInFlight + aiQueue.size;
    const neededCompanies = () => Math.max(0, targetLeadCount - metrics.hubspotWritten - countHeldQualifiedStates() - countAiPending());

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
        processedFilters: metrics.exaRequests,
        totalFilters: undefined,
        foundCandidates: countHeldQualifiedStates(),
        targetLeadCount,
        funnel: {
          crawledPages: 0,
          afterCrawlerPrefilter: metrics.exaRawFound,
          afterHubSpotDedup: countHeldQualifiedStates(),
          afterAzureAICheck: metrics.aiAccepted,
          syncedToHubSpot: metrics.hubspotWritten
        },
        timedOut,
        stopped: stopping,
        updatedAt: new Date().toISOString(),
        workerMetrics: {
          ...metrics,
          queueSizes: { ...metrics.queueSizes }
        },
        debugMessages: [...recentDebugMessages]
      };

      options.onProgress?.(progress);
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
              decisionSamples: aggregate.decisionSamples.slice(0, 10)
            } satisfies SearchHistoryEntry;
          });

        await this.controlPlaneStore.recordSearchHistory("exa_search", entries);
      }
    };

    const maybePromoteStandby = () => {
      while (standbyQualifiedStates.length > 0 && countAssignedQualifiedStates() < targetLeadCount && !stopping) {
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
        log(`Standby-Firma freigegeben: ${nextState.company.name}`);
      }
      emitProgress();
    };

    const queueQualifiedCompany = (company: PreCategorizedCompany, source: "seed" | "exa", searchId?: string) => {
      const key = buildCompanyKey(company);
      if (qualifiedStates.has(key) || standbyQualifiedStates.some((state) => state.key === key)) {
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
      if (activeBefore < targetLeadCount && !stopping) {
        state.pipelineAssigned = true;
        outreachQueue.enqueue(state);
        contactQueue.enqueue(state);
        log(`KI hat Zieltreffer freigegeben: ${company.name}`);
      } else {
        standbyQualifiedStates.push(state);
        screeningQueue.enqueue({
          type: "upsert",
          record: buildScreeningRecord(company)
        });
        log(`KI-Treffer auf Warteliste gelegt: ${company.name}`);
      }
      emitProgress();
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
        if (stopping) {
          break;
        }

        const item = await aiQueue.dequeue();
        if (!item) {
          break;
        }

        metrics.queueSizes.aiInFlight += 1;
        emitProgress();
        try {
          const analysis = await this.debugConsoleService.classifyCompanyForExecution(item.company);
          const categorizedCompany = analysis.categorizedCompany;
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

          if (targetCategories.includes(categorizedCompany.category as SelectableLeadCategory)) {
            queueQualifiedCompany(categorizedCompany, "exa", item.searchId);
          } else if (categorizedCompany.category === "other") {
            metrics.aiRejectedOther += 1;
          } else {
            metrics.aiRejectedDifferentCategory += 1;
          }
        } catch (error) {
          metrics.aiRejectedOther += 1;
          log(`KI-Worker Fehler fuer ${item.company.name}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          metrics.queueSizes.aiInFlight = Math.max(0, metrics.queueSizes.aiInFlight - 1);
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
          state.researchBrief = await this.debugConsoleService.buildResearchBriefForExecution(state.company);
          state.outreachStatus = "done";
          metrics.outreachCompleted += 1;
          log(`Outreach fertig: ${state.company.name}`);
          maybeQueueHubSpot(state);
        } catch (error) {
          state.outreachStatus = "failed";
          state.removed = true;
          state.pipelineAssigned = false;
          metrics.outreachFailed += 1;
          log(`Outreach fehlgeschlagen, Firma entfernt: ${state.company.name}`);
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
          const contactDebug = await Promise.race<ContactDebugResult>([
            this.debugConsoleService.discoverContactsForExecution(state.company, {
              selectedContactsTimeoutMs: 90_000
            }),
            delay(this.contactTaskTimeoutMs).then(() => {
              throw new Error(`Contact worker timed out after ${this.contactTaskTimeoutMs}ms`);
            })
          ]);
          state.contacts = contactDebug.selectedContacts ?? [];
          state.contactStatus = "done";
          metrics.contactCompleted += 1;
          log(`Kontakte fertig: ${state.company.name} (${state.contacts.length})`);
          maybeQueueHubSpot(state);
        } catch (error) {
          state.contactStatus = "failed";
          metrics.contactFailed += 1;
          state.contacts = [];
          log(`Kontakt-Worker Fehler fuer ${state.company.name}: ${error instanceof Error ? error.message : String(error)}`);
          maybeQueueHubSpot(state);
        } finally {
          metrics.queueSizes.contactInFlight = Math.max(0, metrics.queueSizes.contactInFlight - 1);
          emitProgress();
        }
      }
    })());

    const hubspotWorker = (async () => {
      while (true) {
        const state = await hubspotQueue.dequeue();
        if (!state) {
          break;
        }

        if (state.removed || state.hubspotStatus === "done") {
          continue;
        }

        metrics.queueSizes.hubspotInFlight += 1;
        state.hubspotStatus = "running";
        emitProgress();
        try {
          const companySyncKey = new URL(state.company.domain?.startsWith("http") ? state.company.domain : `https://${state.company.domain ?? state.company.name}`).hostname.replace(/^www\./i, "").toLowerCase();
          const syncResult = await this.hubSpotClient.syncQualifiedCompanies(
            [state.company],
            state.researchBrief ? [state.researchBrief] : [],
            new Map<string, PublicContactCandidate[]>([[companySyncKey, state.contacts]]),
            Boolean(request.dryRun || request.syncToHubSpot === false)
          );
          state.hubspotStatus = "done";
          state.pipelineAssigned = false;
          state.completedAt = new Date().toISOString();
          metrics.hubspotWritten += syncResult.companySyncedCount;
          screeningQueue.enqueue({
            type: "mark-hubspot",
            key: state.key,
            companyName: state.company.name,
            domain: state.company.domain,
            category: state.company.category,
            sourceFilter: state.company.sourceFilter
          });
          log(`HubSpot fertig: ${state.company.name}`);
          maybePromoteStandby();
        } catch (error) {
          state.hubspotStatus = "failed";
          state.hubspotError = error instanceof Error ? error.message : String(error);
          log(`HubSpot Fehler fuer ${state.company.name}: ${state.hubspotError}`);
        } finally {
          metrics.queueSizes.hubspotInFlight = Math.max(0, metrics.queueSizes.hubspotInFlight - 1);
          emitProgress();
        }
      }
    })();

    const seedRecords = screeningDatabase.records.filter((record) => {
      if (record.existsInHubSpot) {
        return false;
      }
      if (!record.category || !targetCategories.includes(record.category as SelectableLeadCategory)) {
        return false;
      }
      return !record.sourceFilter?.includes("debug-stage=");
    }).slice(0, targetLeadCount);

    for (const record of seedRecords) {
      const website = toCompanyWebsite(record.domain);
      const sourceFilter = record.sourceFilter ?? `cached-live-category:${record.category}`;
      const company = website
        ? this.debugConsoleService.createManualCompanyForWebsite(website, filters[0])
        : {
            name: record.companyName,
            domain: record.domain,
            shortDescription: record.shortDescription ?? "", 
            sourceFilter
          };
      const categorized: PreCategorizedCompany = {
        ...company,
        category: record.category ?? filters[0].targetCategories?.[0] ?? targetCategories[0],
        relevanceScore: record.relevanceScore ?? 0.75,
        rationale: record.rationale ?? "Bereits im Live-Screening als passend klassifiziert."
      };
      const key = buildCompanyKey(categorized);
      seenCompanyKeys.add(key);
      queueQualifiedCompany(categorized, "seed");
      screeningQueue.enqueue({ type: "remove", key });
    }

    const exaWorker = (async () => {
      while (!stopping && Date.now() < deadlineMs && metrics.hubspotWritten < targetLeadCount) {
        maybePromoteStandby();
        if (neededCompanies() <= 0) {
          await delay(SEARCH_IDLE_MS);
          continue;
        }

        const filter = filters[searchCounter % filters.length];
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
          decisionSamples: []
        };
        searchAggregates.set(searchId, aggregate);
        metrics.exaRequests += 1;
        searchCounter += 1;
        log(`Exa-Worker startet Batch ${searchId} fuer ${filter.name}`);

        const additionalExcludedDomains = Array.from(excludedDomains);
        const rawCompanies = await this.leadPipelineAgent.discoverDirectExaCompaniesForExecution(
          filter,
          targetCategories,
          exaQueryCount,
          additionalExcludedDomains,
          (update) => {
            aggregate.executedQueries = update.executedQueries;
            aggregate.rawFound = update.rawCompaniesFound;
            aggregate.queryTexts.push(update.query);
            historyQueue.enqueue({ type: "upsert-search", aggregate: { ...aggregate, queryTexts: [...aggregate.queryTexts] } });
          }
        );

        const uniqueRawCompanies: CompanySample[] = [];
        for (const company of rawCompanies) {
          const key = buildCompanyKey(company);
          if (seenCompanyKeys.has(key)) {
            continue;
          }
          seenCompanyKeys.add(key);
          uniqueRawCompanies.push(company);
          const normalizedDomain = normalizeDomain(company.domain);
          if (normalizedDomain) {
            excludedDomains.add(normalizedDomain);
          }
        }

        aggregate.rawFound = uniqueRawCompanies.length;
        metrics.exaRawFound += uniqueRawCompanies.length;
        historyQueue.enqueue({ type: "upsert-search", aggregate: { ...aggregate, queryTexts: [...new Set(aggregate.queryTexts)] } });

        if (uniqueRawCompanies.length > 0) {
          await this.controlPlaneStore.recordLiveExaRawResults(uniqueRawCompanies.map((company) => ({
            timestamp: new Date().toISOString(),
            domain: normalizeDomain(company.domain) ?? company.name.trim().toLowerCase(),
            companyName: company.name,
            discoveryQuery: company.discoveryQuery,
            sourceFilter: company.sourceFilter
          })));
        }

        for (const company of uniqueRawCompanies.slice(0, SEARCH_BATCH_SIZE + SEARCH_RESULT_HEADROOM)) {
          aiQueue.enqueue({ company, searchId });
        }

        emitProgress();
      }

      searchCompleted = true;
      aiQueue.close();
      emitProgress();
    })();

    const abortHandler = () => {
      stopping = true;
      stopReason = stopReason || "manually_stopped";
      log("Stop angefordert. Neue Exa- und KI-Aufgaben werden nicht mehr gestartet.");
      aiQueue.close();
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
          log("Zeitlimit erreicht. Lauf schliesst nur noch bereits freigegebene Firmen sauber ab.");
          aiQueue.close();
        }

        if (metrics.hubspotWritten >= targetLeadCount) {
          stopReason = stopReason || "target_reached";
          stopping = true;
          aiQueue.close();
        }

        if (stopping && countAiPending() === 0 && countDownstreamInFlight() === 0) {
          break;
        }

        if (!stopping && searchCompleted && countAiPending() === 0 && countDownstreamInFlight() === 0 && standbyQualifiedStates.length === 0) {
          break;
        }

        await delay(SEARCH_IDLE_MS);
      }

      await exaWorker;
      outreachQueue.close();
      contactQueue.close();
      await Promise.all(aiWorkers);
      await Promise.all(outreachWorkers);
      await Promise.all(contactWorkers);
      hubspotQueue.close();
      await hubspotWorker;

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
    } finally {
      options.signal?.removeEventListener("abort", abortHandler);
    }

    if (screeningFlushDue) {
      await this.controlPlaneStore.writeCompanyScreeningDatabase(screeningState);
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
          decisionSamples: aggregate.decisionSamples.slice(0, 10)
        } satisfies SearchHistoryEntry;
      });

    const completedStates = Array.from(qualifiedStates.values())
      .filter((state) => state.researchBrief)
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
      stopped: stopping,
      completionReason: stopReason || (metrics.hubspotWritten >= targetLeadCount ? "target_reached" : "search_exhausted"),
      costs: undefined
    };

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
        stopped: stopping,
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
}