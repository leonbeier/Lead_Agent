import React from "react";
import {
  Alert,
  Button,
  ButtonRow,
  Checkbox,
  Divider,
  Flex,
  Heading,
  LoadingButton,
  NumberInput,
  ProgressBar,
  StatusTag,
  Text,
  TextArea,
  hubspot
} from "@hubspot/ui-extensions";

hubspot.extend(({ actions, context }) => {
  const openIframe = "openIframeModal" in actions ? actions.openIframeModal : undefined;

  return (
    <LeadAgentCard
      openIframe={openIframe}
      portalId={String(context.portal.id)}
      baseUrl={String(context.variables?.LEAD_AGENT_API_BASE_URL || "")}
      sharedKey={String(context.variables?.LEAD_AGENT_SHARED_KEY || "")}
    />
  );
});

type LeadAgentCardProps = {
  openIframe?: (payload: { uri: string; height: number; width: number; title: string; flush?: boolean }) => void;
  portalId: string;
  baseUrl: string;
  sharedKey: string;
};

type CategoryOption = {
  value: string;
  label: string;
};

type SidebarSearchMode = "exa_search" | "diffbot_search";

const SIDEBAR_CATEGORY_OPTIONS: CategoryOption[] = [
  { value: "integrator_vision_industrial_ai", label: "Software Integratoren mit Vision/Industrial AI Fokus" },
  { value: "integrator_vision_ai_consulting", label: "Vision AI/Industrial AI Consulting" },
  { value: "integrator_vision_ai_freelancer", label: "Vision AI/Industrial AI Freelancer" },
  { value: "integrator_general_ai", label: "Software Integratoren mit allgemeinem AI Fokus" },
  { value: "integrator_relevant_focus", label: "Integratoren in relevanten Industriezweigen" },
  { value: "industrial_end_customer_scaled", label: "Industrie-Endkunden mit ausreichender Projektgroesse" },
  { value: "camera_manufacturer_partner", label: "Kamera-/Imaging-Hersteller als Partner" },
  { value: "machine_builder_ai_enablement", label: "Maschinenbauer mit AI-Option Potenzial" },
  { value: "software_platform_embedding", label: "Softwareplattformen fuer Embedding-Partnerschaften" }
];

const SIDEBAR_DEFAULT_TARGET_LEADS = 20;

type SettingsPayload = {
  settings?: {
    targetLeadCount?: number;
    market?: string;
    targetCategories?: string[];
    companySearchMode?: "internet_research" | "open_crawler_search" | "apollo_search" | "exa_search" | "diffbot_search" | "diffbot_test_data";
    syncToHubSpot?: boolean;
    exaApiKey?: string;
    diffbotToken?: string;
    maxRuntimeMs?: number;
    aiPrefilterConcurrency?: number;
    outreachPrepConcurrency?: number;
    contactSearchConcurrency?: number;
  };
};

type LatestLeadRunPayload = {
  selectableCategories?: CategoryOption[];
  latestLeadRun?: {
    createdAt?: string;
    summary?: {
      foundCandidates?: number;
    };
  };
};

type ConsoleEntry = {
  id: string;
  message: string;
};

type RunStatusPayload = {
  runStatus?: {
    running?: boolean;
    startedAt?: string;
    finishedAt?: string;
    lastError?: string;
    stage?: string;
    stageLabel?: string;
    progressValue?: number;
    progressMax?: number;
    progressDescription?: string;
    detail?: string;
    processedFilters?: number;
    totalFilters?: number;
    foundCandidates?: number;
    targetLeadCount?: number;
    updatedAt?: string;
  };
};

function formatTimestamp(value?: string) {
  if (!value) {
    return "unbekannt";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function compactSidebarStatus(value: string | undefined, maxLength = 120) {
  if (!value) {
    return "";
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function isMeaningfulRunStatus(runStatus?: RunStatusPayload["runStatus"]) {
  if (!runStatus) {
    return false;
  }

  if (runStatus.running || runStatus.lastError || runStatus.finishedAt) {
    return true;
  }

  if (!runStatus.updatedAt) {
    return false;
  }

  const updatedAt = new Date(runStatus.updatedAt);
  return !Number.isNaN(updatedAt.getTime()) && updatedAt.getTime() > 0;
}

function getSearchModeLabel(mode: SidebarSearchMode) {
  if (mode === "exa_search") {
    return "Exa Search";
  }

  return "Diffbot Search";
}

function normalizeSidebarSearchMode(
  mode: SettingsPayload["settings"] extends { companySearchMode?: infer T } ? T : never
): SidebarSearchMode {
  if (mode === "diffbot_search") {
    return "diffbot_search";
  }

  return "exa_search";
}

function LeadAgentCard({ openIframe, portalId, baseUrl, sharedKey }: LeadAgentCardProps) {
  const [isLoading, setIsLoading] = React.useState(true);
  const [isStarting, setIsStarting] = React.useState(false);
  const [isStoppingRun, setIsStoppingRun] = React.useState(false);
  const [isResettingRun, setIsResettingRun] = React.useState(false);
  const [isRefreshingStatus, setIsRefreshingStatus] = React.useState(false);
  const [targetLeadCount, setTargetLeadCount] = React.useState<number>(SIDEBAR_DEFAULT_TARGET_LEADS);
  const [market, setMarket] = React.useState<string>("Europe");
  const [companySearchMode, setCompanySearchMode] = React.useState<SidebarSearchMode>("exa_search");
  const [selectedCategories, setSelectedCategories] = React.useState<string[]>([]);
  const [latestFoundCandidates, setLatestFoundCandidates] = React.useState<number | null>(null);
  const [runStatus, setRunStatus] = React.useState<RunStatusPayload["runStatus"]>({ running: false });
  const [errorMessage, setErrorMessage] = React.useState<string>("");
  const [successMessage, setSuccessMessage] = React.useState<string>("");
  const [syncToHubSpot, setSyncToHubSpot] = React.useState(true);
  const [exaApiKey, setExaApiKey] = React.useState("");
  const [diffbotToken, setDiffbotToken] = React.useState("");
  const [maxRuntimeMinutes, setMaxRuntimeMinutes] = React.useState<number>(20);
  const [aiPrefilterConcurrency, setAiPrefilterConcurrency] = React.useState<number>(8);
  const [outreachPrepConcurrency, setOutreachPrepConcurrency] = React.useState<number>(6);
  const [contactSearchConcurrency, setContactSearchConcurrency] = React.useState<number>(8);
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const consoleUrl = `${normalizedBaseUrl}/hubspot/ui?portalId=${encodeURIComponent(portalId)}&key=${encodeURIComponent(sharedKey)}`;
  const canOpenConsole = Boolean(normalizedBaseUrl && sharedKey && openIframe);
  const canFetch = Boolean(normalizedBaseUrl && sharedKey);
  const canStart = canFetch && targetLeadCount > 0 && selectedCategories.length > 0 && !runStatus?.running;
  const progressMax = Math.max(1, runStatus?.progressMax ?? 100);
  const progressValue = Math.min(progressMax, Math.max(0, runStatus?.progressValue ?? 0));

  const requestJson = React.useCallback(async <T,>(
    pathname: string,
    options?: { method?: "GET" | "POST"; timeout?: number }
  ) => {
    const response = await hubspot.fetch(`${normalizedBaseUrl}${pathname}?key=${encodeURIComponent(sharedKey)}`, {
      method: options?.method ?? "GET",
      timeout: options?.timeout ?? 120000
    });

    let payload: unknown = undefined;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const message = typeof payload === "object" && payload && "error" in payload
        ? String((payload as { error?: string }).error)
        : `Request failed with status ${response.status}`;
      throw new Error(message);
    }

    return payload as T;
  }, [normalizedBaseUrl, sharedKey]);

  const refreshRunStatus = React.useCallback(async () => {
    if (!canFetch) {
      return;
    }

    const payload = await requestJson<RunStatusPayload>("/api/control/run-status", { timeout: 15000 });
    setRunStatus(payload.runStatus ?? { running: false });
  }, [canFetch, requestJson]);

  const refreshLatestRun = React.useCallback(async () => {
    if (!canFetch) {
      return;
    }

    const payload = await requestJson<LatestLeadRunPayload>("/api/control/latest-lead-run", { timeout: 20000 });
    setLatestFoundCandidates(payload.latestLeadRun?.summary?.foundCandidates ?? null);
  }, [canFetch, requestJson]);

  const refreshRuntimeData = React.useCallback(async () => {
    await Promise.all([refreshRunStatus(), refreshLatestRun()]);
  }, [refreshLatestRun, refreshRunStatus]);

  const toggleCategory = (category: string, checked: boolean) => {
    setSelectedCategories((current) => {
      if (checked) {
        return current.includes(category) ? current : [...current, category];
      }

      return current.filter((entry) => entry !== category);
    });
  };

  const handleManualRefresh = async () => {
    if (!canFetch) {
      return;
    }

    try {
      setIsRefreshingStatus(true);
      setErrorMessage("");
      await refreshRuntimeData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Run-Status konnte nicht aktualisiert werden.");
    } finally {
      setIsRefreshingStatus(false);
    }
  };

  React.useEffect(() => {
    if (!canFetch) {
      setIsLoading(false);
      return;
    }

    let isCancelled = false;

    const load = async () => {
      try {
        setErrorMessage("");
        const settingsPayload = await requestJson<SettingsPayload>("/api/control/settings", { timeout: 12000 });

        if (isCancelled) {
          return;
        }

        setTargetLeadCount(Math.max(settingsPayload.settings?.targetLeadCount ?? SIDEBAR_DEFAULT_TARGET_LEADS, SIDEBAR_DEFAULT_TARGET_LEADS));
        setMarket(settingsPayload.settings?.market ?? "Europe");
        setCompanySearchMode(normalizeSidebarSearchMode(settingsPayload.settings?.companySearchMode));
        setSyncToHubSpot(settingsPayload.settings?.syncToHubSpot ?? true);
        setExaApiKey(settingsPayload.settings?.exaApiKey ?? "");
        setDiffbotToken(settingsPayload.settings?.diffbotToken ?? "");
        setMaxRuntimeMinutes(Math.max(1, Math.round((settingsPayload.settings?.maxRuntimeMs ?? 1_200_000) / 60_000)));
        setAiPrefilterConcurrency(settingsPayload.settings?.aiPrefilterConcurrency ?? 8);
        setOutreachPrepConcurrency(settingsPayload.settings?.outreachPrepConcurrency ?? 6);
        setContactSearchConcurrency(settingsPayload.settings?.contactSearchConcurrency ?? 8);
        setSelectedCategories(settingsPayload.settings?.targetCategories ?? []);
      } catch (error) {
        if (!isCancelled) {
          setErrorMessage(error instanceof Error ? error.message : "Lead-Agent-Daten konnten nicht geladen werden.");
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }

      refreshRuntimeData().catch((error) => {
        if (!isCancelled) {
          const message = error instanceof Error ? error.message : "Run-Status konnte nicht aktualisiert werden.";
          setErrorMessage((current) => current || message);
        }
      });
    };

    load().catch(() => undefined);

    return () => {
      isCancelled = true;
    };
  }, [canFetch, refreshRuntimeData, requestJson]);

  React.useEffect(() => {
    if (!canFetch) {
      return;
    }

    const handle = setInterval(() => {
      refreshRuntimeData()
        .catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : "Run-Status konnte nicht aktualisiert werden.");
        });
    }, 5000);

    return () => clearInterval(handle);
  }, [canFetch, refreshRuntimeData]);

  const resetLeadRun = async () => {
    if (!canFetch || isResettingRun) {
      return;
    }

    try {
      setIsResettingRun(true);
      setErrorMessage("");
      setSuccessMessage("");

      const payload = await requestJson<{ accepted?: boolean; error?: string; runStatus?: RunStatusPayload["runStatus"] }>(
        "/api/control/run-status/reset",
        { method: "POST" }
      );

      if (!payload.accepted) {
        throw new Error(payload.error || "Lead-Run konnte nicht zurueckgesetzt werden.");
      }

      setRunStatus(payload.runStatus ?? { running: false });
      setSuccessMessage("Blockierter Lead-Run wurde freigegeben.");
      await refreshRuntimeData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Lead-Run konnte nicht zurueckgesetzt werden.");
    } finally {
      setIsResettingRun(false);
    }
  };

  const stopLeadRun = async () => {
    if (!canFetch || isStoppingRun || !runStatus?.running) {
      return;
    }

    try {
      setIsStoppingRun(true);
      setErrorMessage("");
      setSuccessMessage("");

      const payload = await requestJson<{ accepted?: boolean; error?: string; runStatus?: RunStatusPayload["runStatus"] }>(
        "/api/control/run-status/stop",
        { method: "POST" }
      );

      if (!payload.accepted) {
        throw new Error(payload.error || "Lead-Run konnte nicht gestoppt werden.");
      }

      setRunStatus(payload.runStatus ?? { running: true });
      setSuccessMessage("Lead-Run wird gestoppt.");
      await refreshRuntimeData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Lead-Run konnte nicht gestoppt werden.");
    } finally {
      setIsStoppingRun(false);
    }
  };

  const startLeadRun = async () => {
    if (!canStart) {
      return;
    }

    try {
      setIsStarting(true);
      setErrorMessage("");
      setSuccessMessage("");

      const response = await hubspot.fetch(`${normalizedBaseUrl}/api/hubspot/workflow-trigger?key=${encodeURIComponent(sharedKey)}`, {
        method: "POST",
        timeout: 120000,
        body: {
          targetLeadCount,
          market,
          targetCategories: selectedCategories,
          companySearchMode,
          creditLessMode: true,
          dryRun: false,
          syncToHubSpot,
          reuseQualifiedCompanyCache: false,
          exaApiKey: exaApiKey.trim() || undefined,
          diffbotToken: diffbotToken.trim() || undefined,
          maxRuntimeMs: Math.max(60_000, Math.round(Math.max(1, maxRuntimeMinutes || 20) * 60_000)),
          earlyStopEnabled: false,
          aiPrefilterConcurrency,
          outreachPrepConcurrency,
          contactSearchConcurrency
        }
      });

      const payload = await response.json() as { accepted?: boolean; error?: string; runStatus?: RunStatusPayload["runStatus"] };
      if (!response.ok || !payload.accepted) {
        if (response.status === 409) {
          setRunStatus(payload.runStatus ?? { running: true });
          throw new Error("Lead-Run ist blockiert. Status aktualisieren oder blockierten Run freigeben.");
        }

        throw new Error(payload.error || "Lead-Run konnte nicht gestartet werden.");
      }

      setRunStatus(payload.runStatus ?? { running: true });
      setSuccessMessage("Lead-Run wurde gestartet.");
      await refreshRuntimeData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Lead-Run konnte nicht gestartet werden.");
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <Flex direction="column" gap="small">
      <Heading>Lead Agent</Heading>
      <Text>Schnellstart direkt in der Unternehmens-Sidebar mit Zielanzahl, Lead-Klassen und Live-Start.</Text>
      {!canFetch && <Alert title="Fehlende Variablen">LEAD_AGENT_API_BASE_URL oder LEAD_AGENT_SHARED_KEY fehlen im HubSpot-Projekt.</Alert>}
      {errorMessage && <Alert title="Fehler" variant="error">{errorMessage}</Alert>}
      {successMessage && <Alert title="Status" variant="success">{successMessage}</Alert>}
      {runStatus?.running && <Alert title="Lead-Run aktiv">Laufend seit {formatTimestamp(runStatus.startedAt)}.</Alert>}
      {runStatus?.running && (
        <Button
          variant="destructive"
          disabled={!canFetch || isLoading || isStoppingRun}
          onClick={stopLeadRun}
        >
          {isStoppingRun ? "Stoppe aktive Suche..." : "Aktive Suche sofort stoppen"}
        </Button>
      )}
      {!runStatus?.running && runStatus?.finishedAt && !runStatus?.lastError && runStatus?.stage === "completed" && (
        <Alert title="Letzter Lauf abgeschlossen" variant="success">
          Fertig seit {formatTimestamp(runStatus.finishedAt)}.
        </Alert>
      )}
      {typeof latestFoundCandidates === "number" && !runStatus?.running && (
        <Text>Letzter Lauf: {latestFoundCandidates} qualifizierte Firmen.</Text>
      )}
      <Divider />
      <Flex direction="column" gap="extra-small">
        <Flex direction="row" justify="between" align="center">
          <Heading>Run-Status</Heading>
          <StatusTag variant={runStatus?.lastError ? "danger" : runStatus?.running ? "warning" : "success"}>
            {runStatus?.stageLabel || (runStatus?.running ? "Laeuft" : "Bereit")}
          </StatusTag>
        </Flex>
        <ProgressBar
          title={runStatus?.running ? "Lead-Run Fortschritt" : "Noch kein aktiver Lead-Run."}
          value={progressValue}
          maxValue={progressMax}
          showPercentage={true}
          variant={runStatus?.lastError ? "danger" : runStatus?.running ? "warning" : "success"}
        />
        {runStatus?.progressDescription && <Text>{compactSidebarStatus(runStatus.progressDescription, 96)}</Text>}
        {runStatus?.detail && <Text>{compactSidebarStatus(runStatus.detail, 96)}</Text>}
        {(typeof runStatus?.funnel?.afterCrawlerPrefilter === "number" || typeof runStatus?.foundCandidates === "number") && (
          <Text>
            {typeof runStatus?.funnel?.afterCrawlerPrefilter === "number"
              ? `Roh von Exa erkannt: ${runStatus.funnel.afterCrawlerPrefilter}. `
              : ""}
            {typeof runStatus?.funnel?.afterHubSpotDedup === "number"
              ? `Qualifiziert und nicht schon in HubSpot: ${runStatus.funnel.afterHubSpotDedup}. `
              : ""}
            {typeof runStatus?.funnel?.syncedToHubSpot === "number" && syncToHubSpot
              ? `Nach HubSpot synchronisiert: ${runStatus.funnel.syncedToHubSpot}${typeof runStatus?.targetLeadCount === "number" ? `/${runStatus.targetLeadCount}` : ""}. `
              : ""}
            {typeof runStatus?.funnel?.afterAzureAICheck === "number"
              ? `Nach KI geprueft passend: ${runStatus.funnel.afterAzureAICheck}${typeof runStatus?.targetLeadCount === "number" ? `/${runStatus.targetLeadCount}` : ""}.`
              : typeof runStatus?.foundCandidates === "number"
                ? `Nach KI geprueft passend: ${runStatus.foundCandidates}${typeof runStatus?.targetLeadCount === "number" ? `/${runStatus.targetLeadCount}` : ""}.`
                : ""}
          </Text>
        )}
        <Text>HubSpot-Sync fuer Starts aus dieser Karte: {syncToHubSpot ? "aktiv" : "deaktiviert"}. Suchmodus: {getSearchModeLabel(companySearchMode)}. Markt: {market}.</Text>
        <Text>Aktive Kundentypen: {selectedCategories.length || 0}.</Text>
        <Checkbox
          name="diffbotSearchMode"
          checked={companySearchMode === "diffbot_search"}
          onChange={(checked) => setCompanySearchMode(checked ? "diffbot_search" : "exa_search")}
          readOnly={!canFetch || isLoading || Boolean(runStatus?.running)}
        >
          Diffbot Search statt Exa Search verwenden
        </Checkbox>
        <TextArea
          name="market"
          label="Markt / Suchbereich"
          description="Freitext. Dieser Wert geht in die KI- und Suchstrategie-Prompts ein. Default: Europe."
          value={market}
          rows={2}
          resize="vertical"
          onChange={setMarket}
          readOnly={!canFetch || isLoading || Boolean(runStatus?.running)}
        />
        <NumberInput
          label="Zeitlimit in Minuten"
          name="maxRuntimeMinutes"
          min={1}
          max={180}
          step={1}
          value={maxRuntimeMinutes}
          onChange={(value) => setMaxRuntimeMinutes(Number(value) || 1)}
          readOnly={!canFetch || isLoading || Boolean(runStatus?.running)}
        />
        <NumberInput
          label="KI Vorfilter parallel"
          name="aiPrefilterConcurrency"
          min={1}
          max={32}
          step={1}
          value={aiPrefilterConcurrency}
          onChange={(value) => setAiPrefilterConcurrency(Number(value) || 1)}
          readOnly={!canFetch || isLoading || Boolean(runStatus?.running)}
        />
        <NumberInput
          label="Outreach parallel"
          name="outreachPrepConcurrency"
          min={1}
          max={32}
          step={1}
          value={outreachPrepConcurrency}
          onChange={(value) => setOutreachPrepConcurrency(Number(value) || 1)}
          readOnly={!canFetch || isLoading || Boolean(runStatus?.running)}
        />
        <NumberInput
          label="Kontaktsuche parallel"
          name="contactSearchConcurrency"
          min={1}
          max={32}
          step={1}
          value={contactSearchConcurrency}
          onChange={(value) => setContactSearchConcurrency(Number(value) || 1)}
          readOnly={!canFetch || isLoading || Boolean(runStatus?.running)}
        />
        <TextArea
          name="exaApiKey"
          label="Exa API Key"
          description="Optionaler manueller Override fuer Exa Search. Leer nutzt deinen hinterlegten Server-Default-Key. Wenn hier etwas steht, wird dieser Key fuer Exa Search verwendet."
          value={exaApiKey}
          rows={2}
          resize="vertical"
          onChange={setExaApiKey}
          readOnly={!canFetch || isLoading || Boolean(runStatus?.running)}
        />
        <TextArea
          name="diffbotToken"
          label="Diffbot Token"
          description="Optionaler manueller Override fuer Diffbot Search. Leer nutzt deinen hinterlegten Standard-Token. Wenn hier etwas steht, wird dieser Token fuer Diffbot Search verwendet."
          value={diffbotToken}
          rows={3}
          resize="vertical"
          onChange={setDiffbotToken}
          readOnly={!canFetch || isLoading || Boolean(runStatus?.running)}
        />
        {runStatus?.updatedAt && <Text>Zuletzt aktualisiert: {formatTimestamp(runStatus.updatedAt)}</Text>}
        <Divider />
        <ButtonRow disableDropdown={true}>
          <Button
            variant="secondary"
            disabled={!canFetch || isLoading || isRefreshingStatus}
            onClick={handleManualRefresh}
          >
            {isRefreshingStatus ? "Aktualisiere..." : "Status aktualisieren"}
          </Button>
          <Button
            variant="secondary"
            disabled={!canFetch || isLoading || !runStatus?.running || isStoppingRun}
            onClick={stopLeadRun}
          >
            {isStoppingRun ? "Stoppe..." : "Aktuelle Suche stoppen"}
          </Button>
          <Button
            variant="secondary"
            disabled={!canFetch || isLoading || isResettingRun || Boolean(runStatus?.running)}
            onClick={resetLeadRun}
          >
            {isResettingRun ? "Gebe frei..." : "Blockierten Run freigeben"}
          </Button>
        </ButtonRow>
        <Button
          variant="secondary"
          disabled={!canOpenConsole}
          onClick={() => {
            if (!openIframe) {
              return;
            }

            openIframe({
              uri: consoleUrl,
              height: 900,
              width: 1400,
              title: "ONE WARE Lead Console",
              flush: true
            });
          }}
        >
          Zur Lead Console Website
        </Button>
      </Flex>
      <Divider />
      <NumberInput
        label="Zielanzahl Leads"
        name="targetLeadCount"
        min={SIDEBAR_DEFAULT_TARGET_LEADS}
        max={1000}
        value={targetLeadCount}
        onChange={(value) => setTargetLeadCount(Math.max(Number(value) || SIDEBAR_DEFAULT_TARGET_LEADS, SIDEBAR_DEFAULT_TARGET_LEADS))}
        readOnly={!canFetch || isLoading || Boolean(runStatus?.running)}
      />
      <Flex direction="column" gap="flush">
        <Text>Gewuenschte Kundentypen</Text>
        {SIDEBAR_CATEGORY_OPTIONS.map((category) => (
          <Checkbox
            key={category.value}
            name="targetCategories"
            value={category.value}
            checked={selectedCategories.includes(category.value)}
            onChange={(checked) => toggleCategory(category.value, checked)}
            readOnly={!canFetch || isLoading || Boolean(runStatus?.running)}
          >
            {category.label}
          </Checkbox>
        ))}
      </Flex>
      <LoadingButton
        variant="primary"
        loading={isStarting}
        disabled={!canStart || isLoading}
        onClick={startLeadRun}
      >
        Lead-Run starten
      </LoadingButton>
    </Flex>
  );
}
