import React from "react";
import { Button, Divider, Flex, Text, hubspot } from "@hubspot/ui-extensions";

hubspot.extend(({ actions, context }) => (
  <LeadAgentCard
    openIframe={actions.openIframeModal}
    portalId={String(context.portal.id)}
    baseUrl={String(context.variables.LEAD_AGENT_API_BASE_URL || "")}
    sharedKey={String(context.variables.LEAD_AGENT_SHARED_KEY || "")}
  />
));

type LeadAgentCardProps = {
  openIframe: (payload: { uri: string; height: number; width: number; title: string; flush?: boolean }) => void;
  portalId: string;
  baseUrl: string;
  sharedKey: string;
};

function LeadAgentCard({ openIframe, portalId, baseUrl, sharedKey }: LeadAgentCardProps) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const consoleUrl = `${normalizedBaseUrl}/hubspot/ui?portalId=${encodeURIComponent(portalId)}&key=${encodeURIComponent(sharedKey)}`;
  const canOpenConsole = Boolean(normalizedBaseUrl && sharedKey);

  return (
    <Flex direction="column" gap="small">
      <Text>Startet Lead-Generierung mit den gespeicherten Defaults und oeffnet die Template-Konsole direkt aus HubSpot.</Text>
      {!canOpenConsole && <Text>Fehlt: HubSpot-Projektvariablen LEAD_AGENT_API_BASE_URL oder LEAD_AGENT_SHARED_KEY.</Text>}
      <Divider />
      <Button
        disabled={!canOpenConsole}
        onClick={() =>
          openIframe({
            uri: consoleUrl,
            height: 900,
            width: 1400,
            title: "ONE WARE Lead Console",
            flush: true
          })
        }
      >
        Lead-Konsole oeffnen
      </Button>
    </Flex>
  );
}
