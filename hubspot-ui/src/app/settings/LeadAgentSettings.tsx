import React from "react";
import { Button, Divider, Flex, Text, hubspot } from "@hubspot/ui-extensions";

hubspot.extend(({ actions, context }) => {
  const openIframe = "openIframeModal" in actions ? actions.openIframeModal : undefined;

  return (
    <LeadAgentSettings
      openIframe={openIframe}
      baseUrl={String(context.variables?.LEAD_AGENT_API_BASE_URL || "")}
      sharedKey={String(context.variables?.LEAD_AGENT_SHARED_KEY || "")}
    />
  );
});

type LeadAgentSettingsProps = {
  openIframe?: (payload: { uri: string; height: number; width: number; title: string; flush?: boolean }) => void;
  baseUrl: string;
  sharedKey: string;
};

function LeadAgentSettings({ openIframe, baseUrl, sharedKey }: LeadAgentSettingsProps) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const consoleUrl = `${normalizedBaseUrl}/hubspot/ui?key=${encodeURIComponent(sharedKey)}`;
  const canOpenConsole = Boolean(normalizedBaseUrl && sharedKey && openIframe);

  return (
    <Flex direction="column" gap="small">
      <Text>Pflegt Default-Settings, Early-Stop-Schwellen und Outreach-Templates in der eingebetteten ONE WARE Konsole.</Text>
      {!canOpenConsole && <Text>Fehlt: HubSpot-Projektvariablen LEAD_AGENT_API_BASE_URL oder LEAD_AGENT_SHARED_KEY.</Text>}
      <Divider />
      <Button
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
        Settings und Templates oeffnen
      </Button>
    </Flex>
  );
}
