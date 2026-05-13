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

type BootstrapPayload = {
  settings?: {
    targetLeadCount?: number;
    targetCategories?: string[];
    companySearchMode?: "internet_research" | "apollo_search";
    syncToHubSpot?: boolean;
  };
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

function LeadAgentCard({ openIframe, portalId, baseUrl, sharedKey }: LeadAgentCardProps) {
  const [isLoading, setIsLoading] = React.useState(true);
  const [isStarting, setIsStarting] = React.useState(false);
  const [isRefreshingStatus, setIsRefreshingStatus] = React.useState(false);
  const [targetLeadCount, setTargetLeadCount] = React.useState<number>(50);
  const [companySearchMode, setCompanySearchMode] = React.useState<"internet_research" | "apollo_search">("internet_research");
  const [selectableCategories, setSelectableCategories] = React.useState<CategoryOption[]>([]);
  const [selectedCategories, setSelectedCategories] = React.useState<string[]>([]);
  const [latestFoundCandidates, setLatestFoundCandidates] = React.useState<number | null>(null);
  const [runStatus, setRunStatus] = React.useState<RunStatusPayload["runStatus"]>({ running: false });
  const [consoleEntries, setConsoleEntries] = React.useState<ConsoleEntry[]>([]);
  const [errorMessage, setErrorMessage] = React.useState<string>("");
  const [successMessage, setSuccessMessage] = React.useState<string>("");
  const [syncToHubSpot, setSyncToHubSpot] = React.useState(true);
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const consoleUrl = `${normalizedBaseUrl}/hubspot/ui?portalId=${encodeURIComponent(portalId)}&key=${encodeURIComponent(sharedKey)}`;
  const canOpenConsole = Boolean(normalizedBaseUrl && sharedKey && openIframe);
  const canFetch = Boolean(normalizedBaseUrl && sharedKey);
  const canStart = canFetch && targetLeadCount > 0 && selectedCategories.length > 0 && !runStatus?.running;
  const progressMax = Math.max(1, runStatus?.progressMax ?? 100);
  const progressValue = Math.min(progressMax, Math.max(0, runStatus?.progressValue ?? 0));
  const lastConsoleSignature = React.useRef<string>("");

  const appendConsoleEntry = React.useCallback((message: string, signature?: string) => {
    const normalizedMessage = message.trim();
    if (!normalizedMessage) {
      return;
    }

    const nextSignature = signature ?? normalizedMessage;
    if (lastConsoleSignature.current === nextSignature) {
      return;
    }

    lastConsoleSignature.current = nextSignature;
    setConsoleEntries((current) => [{
      id: `${Date.now()}-${current.length}`,
      message: normalizedMessage
    }, ...current].slice(0, 12));
  }, []);

  const requestJson = React.useCallback(async <T,>(pathname: string, options?: { method?: "GET" | "POST" }) => {
    const response = await hubspot.fetch(`${normalizedBaseUrl}${pathname}?key=${encodeURIComponent(sharedKey)}`, {
      method: options?.method ?? "GET",
      timeout: 120000
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

    const payload = await requestJson<RunStatusPayload>("/api/control/run-status");
    setRunStatus(payload.runStatus ?? { running: false });
  }, [canFetch, requestJson]);

  const refreshLatestRun = React.useCallback(async () => {
    if (!canFetch) {
      return;
    }

    const payload = await requestJson<BootstrapPayload>("/api/control/latest-lead-run");
    setLatestFoundCandidates(payload.latestLeadRun?.summary?.foundCandidates ?? null);
  }, [canFetch, requestJson]);

  const refreshRuntimeData = React.useCallback(async () => {
    await Promise.all([refreshRunStatus(), refreshLatestRun()]);
  }, [refreshLatestRun, refreshRunStatus]);

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
        const [bootstrapPayload, runStatusPayload] = await Promise.all([
          requestJson<BootstrapPayload>("/api/control-plane/bootstrap"),
          requestJson<RunStatusPayload>("/api/control/run-status")
        ]);

        if (isCancelled) {
          return;
        }

        setSelectableCategories(bootstrapPayload.selectableCategories ?? []);
        setTargetLeadCount(bootstrapPayload.settings?.targetLeadCount ?? 50);
        setCompanySearchMode(bootstrapPayload.settings?.companySearchMode ?? "internet_research");
        setSyncToHubSpot(bootstrapPayload.settings?.syncToHubSpot ?? true);
        setSelectedCategories(bootstrapPayload.settings?.targetCategories ?? []);
        setLatestFoundCandidates(bootstrapPayload.latestLeadRun?.summary?.foundCandidates ?? null);
        setRunStatus(runStatusPayload.runStatus ?? { running: false });
      } catch (error) {
        if (!isCancelled) {
          setErrorMessage(error instanceof Error ? error.message : "Lead-Agent-Daten konnten nicht geladen werden.");
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    load().catch(() => undefined);

    return () => {
      isCancelled = true;
    };
  }, [canFetch, requestJson]);

  React.useEffect(() => {
    if (!runStatus) {
      return;
    }

    const timestamp = formatTimestamp(runStatus.updatedAt ?? runStatus.finishedAt ?? runStatus.startedAt);
    const statusLine = `[${timestamp}] ${runStatus.stageLabel || (runStatus.running ? "Laeuft" : "Bereit")} | ${progressValue}% | ${runStatus.progressDescription || "Noch kein aktiver Lead-Run."}${runStatus.detail ? ` | ${runStatus.detail}` : ""}`;
    const signature = [
      runStatus.updatedAt,
      runStatus.stage,
      runStatus.progressValue,
      runStatus.progressDescription,
      runStatus.detail,
      runStatus.running
    ].join("|");

    appendConsoleEntry(statusLine, signature);
  }, [appendConsoleEntry, progressValue, runStatus]);

  React.useEffect(() => {
    if (!runStatus?.running || !canFetch) {
      return;
    }

    const handle = setInterval(() => {
      refreshRuntimeData()
        .catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : "Run-Status konnte nicht aktualisiert werden.");
        });
    }, 5000);

    return () => clearInterval(handle);
  }, [canFetch, refreshRuntimeData, runStatus?.running]);

  const toggleCategory = (category: string, checked: boolean) => {
    setSelectedCategories((current) => {
      if (checked) {
        return current.includes(category) ? current : [...current, category];
      }

      return current.filter((entry) => entry !== category);
    });
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
          targetCategories: selectedCategories,
          companySearchMode,
          creditLessMode: companySearchMode === "internet_research",
          dryRun: false,
          syncToHubSpot
        }
      });

      const payload = await response.json() as { accepted?: boolean; error?: string; runStatus?: RunStatusPayload["runStatus"] };
      if (!response.ok || !payload.accepted) {
        throw new Error(payload.error || "Lead-Run konnte nicht gestartet werden.");
      }

      setRunStatus(payload.runStatus ?? { running: true });
      setSuccessMessage("Lead-Run wurde gestartet.");
      appendConsoleEntry(
        `[${formatTimestamp(new Date().toISOString())}] Start angefordert | ${targetLeadCount} Leads | Suche ${companySearchMode === "internet_research" ? "Web" : "Apollo"} | HubSpot-Sync ${syncToHubSpot ? "an" : "aus"}`
      );
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
          title={runStatus?.progressDescription || "Noch kein aktiver Lead-Run."}
          value={progressValue}
          maxValue={progressMax}
          showPercentage={true}
          valueDescription={runStatus?.detail || undefined}
          variant={runStatus?.lastError ? "danger" : runStatus?.running ? "warning" : "success"}
        />
        {(typeof runStatus?.processedFilters === "number" || typeof runStatus?.foundCandidates === "number") && (
          <Text>
            {typeof runStatus?.processedFilters === "number" && typeof runStatus?.totalFilters === "number"
              ? `Filter: ${runStatus.processedFilters}/${runStatus.totalFilters}. `
              : ""}
            {typeof runStatus?.foundCandidates === "number"
              ? `Qualifizierte Firmen: ${runStatus.foundCandidates}${typeof runStatus?.targetLeadCount === "number" ? `/${runStatus.targetLeadCount}` : ""}.`
              : ""}
          </Text>
        )}
        <Text>HubSpot-Sync fuer Starts aus dieser Karte: {syncToHubSpot ? "aktiv" : "deaktiviert"}. Suchmodus: {companySearchMode === "internet_research" ? "Web-Recherche" : "Apollo"}.</Text>
        {runStatus?.updatedAt && <Text>Zuletzt aktualisiert: {formatTimestamp(runStatus.updatedAt)}</Text>}
        <Divider />
        <Flex direction="column" gap="flush">
          <Heading>Live-Konsole</Heading>
          {consoleEntries.length === 0 && <Text>Noch keine Statuszeilen.</Text>}
          {consoleEntries.map((entry) => (
            <Text key={entry.id}>{entry.message}</Text>
          ))}
        </Flex>
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
            Lead-Konsole oeffnen
          </Button>
        </ButtonRow>
      </Flex>
      <Divider />
      <NumberInput
        label="Zielanzahl Leads"
        name="targetLeadCount"
        min={1}
        max={1000}
        value={targetLeadCount}
        onChange={(value) => setTargetLeadCount(Number(value) || 1)}
        readOnly={!canFetch || isLoading || Boolean(runStatus?.running)}
      />
      <Flex direction="column" gap="flush">
        <Text>Gewuenschte Kundentypen</Text>
        {selectableCategories.map((category) => (
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
