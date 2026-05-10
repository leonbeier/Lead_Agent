# Lead Agent

Dieses Repo enthaelt ein theoretisch lauffaehiges Grundgeruest fuer einen automatisierten Lead-Workflow mit Apollo, Azure OpenAI und HubSpot.

## Zielbild

Der Workflow ist in vier Stufen aufgeteilt:

1. Apollo Filter Agent: erzeugt und testet Filter-Sets fuer relevante Firmenlisten.
2. Pre-Categorization Agent: bewertet 50er-Samples und looped mit neuen Filterideen zurueck nach Apollo.
3. Deep Research Agent: erstellt Firmen-Overview, finale Qualifikation und Outreach-Vorbereitung fuer LinkedIn, E-Mail und Telefon.
4. HubSpot Sync Agent: schreibt qualifizierte Ergebnisse in HubSpot.

## Was schon vorbereitet ist

- Express API fuer Triggering aus HubSpot oder einem internen Operator-UI
- vordefinierte Apollo Filter-Presets fuer eure ICP-Hypothesen
- Kategorien fuer die Qualifikation
- ein zentraler One-WARE-Prompt- und Template-Layer fuer Qualifizierung und Outreach
- orchestrierte Pipeline mit Dry-Run-Modus ohne API-Keys
- vorbereitete Stellen fuer Apollo-, Azure- und HubSpot-Clients

## Beispielablauf

1. HubSpot oder ein internes UI sendet `targetLeadCount`, `market` und optional `customGoal` an `POST /api/hubspot/workflow-trigger`.
2. Das Backend erzeugt passende Apollo Filter-Vorschlaege.
3. Fuer jedes Filter-Set werden erst 5 bis 15 Firmen schnell angeprueft; nur bei gutem Signal wird bis 50 erweitert.
4. Eine Vorqualifikation zaehlt relevante Kategorien, bricht schwache Filter frueh ab und bewertet die Filterqualitaet.
5. Die besten Filter-Sets werden fuer Deep Research und Outreach Preparation priorisiert.
6. Qualifizierte Firmen oder Kontakte werden an HubSpot uebergeben.

## Relevante Kategorien

- software_integrator
- ai_software_integrator
- machine_builder_with_vision_ai_need
- industrial_camera_vendor_without_ai_software
- irrelevant
- other

## API-Endpunkte

- `GET /health`
- `GET /api/config/readiness`
- `GET /api/apollo/filter-presets`
- `GET /api/control-plane/bootstrap`
- `GET /api/control/settings`
- `PUT /api/control/settings`
- `GET /api/outreach/templates`
- `GET /api/outreach/contexts`
- `PUT /api/outreach/templates/:key`
- `POST /api/lead-jobs/preview`
- `POST /api/lead-jobs/run`
- `POST /api/hubspot/workflow-trigger`

Neue UI-Endpunkte:

- `GET /hubspot`
- `GET /hubspot/ui`

Wichtige optionale Request-Parameter:

- `earlyStopEnabled`: standardmaessig `true`
- `earlyStopReviewCount`: zwischen 5 und 15, standardmaessig `10`
- `earlyStopThreshold`: Mindestquote relevanter Firmen in der Vorprobe, standardmaessig `0.35`
- `agentContext`: freier Operator- oder HubSpot-Kontext fuer Filterstrategie, Qualifikation und Deep Research

Prompt- und Template-Logik:

- die Qualifikation folgt jetzt explizit dem ONE-WARE-ICP aus Software-Integratoren, Industriekunden und Hardwarepartnern
- VCs, Banken, reine Berater und direkte konkurrierende Plattformprofile werden aktiv abgewertet oder ausgeschlossen
- Outreach wird nicht mehr frei neu geschrieben, sondern pro Segment aus festen Templates mit kontrollierter Personalisierung abgeleitet
- pro Firmenkategorie gibt es jetzt eigenen Agent-Kontext fuer Research-Prioritaeten, Outreach-Prioritaeten, Personalisierungsregeln und No-Go-Signale
- dieser Kontext kann ueber `agentContext` aus HubSpot oder dem Operator-UI erweitert werden

## Lokal starten

```bash
npm install
npm run build
npm run dev
```

## Beispiel-Request

```bash
curl -X POST http://localhost:3000/api/hubspot/workflow-trigger \
  -H "Content-Type: application/json" \
  -d '{
    "targetLeadCount": 50,
    "market": "DACH",
    "customGoal": "Find industrial companies where Vision AI can improve QC or automation",
    "earlyStopEnabled": true,
    "earlyStopReviewCount": 10,
    "earlyStopThreshold": 0.35
  }'
```

## Was ich von dir spaeter brauche

- Apollo API key
- HubSpot private app token
- Azure OpenAI endpoint, key und deployment name
- optional: Foundry project endpoint fuer agentische Filteroptimierung, Vorqualifikation und Deep Research mit Web Search oder Bing Grounding
- optional: Foundry Bing connection name, wenn statt allgemeinem Web Search die neue Grounding-with-Bing-Resource verwendet werden soll
- optional: kein zusaetzlicher Search-API-Key noetig, wenn ihr den eingebauten DuckDuckGo-basierten Web-Search-Agent-Fallback nutzt

## Foundry Agent Setup

Das Repo unterstuetzt jetzt optional drei rollenbasierte Foundry-Agents auf der bestehenden Pipeline:

1. Filter Strategy Agent: optimiert Apollo-Filters fuer euren ICP.
2. Pre-Qualification Agent: vorsortiert Firmen strenger nach Delivery-Fit, Geografie und Konkurrenzsignal.
3. Deep Research Agent: nutzt Web Search oder Grounding with Bing Search fuer Firmenrecherche und Outreach-Hooks.

Der Deep Research Agent bekommt jetzt nicht nur ein Template, sondern auch einen kategoriespezifischen Guidance-Block. Dadurch wird je nach Lead-Kategorie unterschiedlich recherchiert und unterschiedlich personalisiert:

- `software_integrator`: Fokus auf Delivery-Druck, Marge, Projektdurchsatz und wiederkehrende Kundenprojekte
- `ai_software_integrator`: Fokus auf Throughput und weniger manuelle Iteration, aber kritisch gegenueber Produkt-Wettbewerbern
- `machine_builder_with_vision_ai_need`: Fokus auf QC, Inspektion, Prozessautomation, Edge-Hardware und Wirtschaftlichkeit
- `industrial_camera_vendor_without_ai_software`: Fokus auf OEM-/Embed-Fit und Ergaenzung einer Hardware-Story ohne starke eigene AI-Software

Empfohlene Umgebungsvariablen:

- `FOUNDRY_PROJECT_ENDPOINT`: `https://<resource>.ai.azure.com/api/projects/<project>`
- `FOUNDRY_MODEL_DEPLOYMENT`: optional, sonst wird `AZURE_OPENAI_DEPLOYMENT` verwendet
- `FOUNDRY_USE_AGENT_FILTERS=true`
- `FOUNDRY_USE_AGENT_QUALIFICATION=true`
- `FOUNDRY_USE_AGENT_RESEARCH=true`
- `FOUNDRY_BING_CONNECTION_NAME`: optionaler Name eurer Foundry-Connection auf die Bing-Grounding-Ressource

Wenn `FOUNDRY_BING_CONNECTION_NAME` gesetzt ist, verwendet der Deep Research Agent eure Grounding-with-Bing-Resource. Wenn nicht, faellt er auf den Foundry-Web-Search-Toolpfad zurueck.

## Eigener Web-Search-Agent ohne Zusatz-API

Wenn Foundry oder Bing Grounding nicht verfuegbar sind, nutzt der Azure-Research-Fallback jetzt einen eingebauten Web-Search-Agent auf Basis von `duck-duck-scrape`.

Der Ablauf ist bewusst einfach gehalten:

1. Es werden mehrere Firmen-Queries gegen DuckDuckGo erzeugt.
2. Die besten Treffer werden dedupliziert.
3. Fuer die ersten Treffer werden Seiteninhalte direkt abgerufen und als Evidenzblock an Azure OpenAI uebergeben.
4. Das Modell erzeugt daraus den bestehenden `ResearchBrief` mit echten Web-Citations.

Relevante Umgebungsvariablen:

- `WEB_SEARCH_AGENT_ENABLED=true`
- `WEB_SEARCH_AGENT_MAX_RESULTS=5`

Damit bekommt ihr echten externen Web-Search im bestehenden Pipeline-Pfad, ohne zusaetzliche Search-Provider-API. Die Grenzen liegen eher bei Trefferqualitaet, Rate-Limits oder HTML-Struktur einzelner Seiten als bei Azure selbst.

Wichtige Betriebshinweise:

- fuer Bing Grounding in Foundry Agents (classic) sollte kein `gpt-5`-Deployment verwendet werden; ein verifizierter kompatibler Pfad in diesem Setup ist `gpt-4.1-mini`
- die aktuelle Implementierung unter `src/clients/foundry-agents.ts` authentifiziert sich mit `DefaultAzureCredential`; fuer echten Betrieb braucht der Runtime-Host deshalb eine funktionierende Entra-ID-Credential-Kette und die Rolle `Azure AI User` auf der Foundry-Resource bzw. dem Projektpfad

## HubSpot- und Operator-Kontext

Ihr koennt jetzt pro Run einen freien `agentContext` mitsenden. Dieser Text wird in drei Phasen verwendet:

1. fuer die Optimierung der Apollo-Filter
2. fuer die Vorsortierung der Firmen
3. fuer die Deep-Research- und Outreach-Vorbereitung

Beispiel:

```json
{
  "targetLeadCount": 25,
  "market": "Germany",
  "customGoal": "Prioritize software integrators and industrial QC teams",
  "agentContext": "Prioritize companies with visible delivery ownership in Germany first. For industrial accounts, favor QC, inspection, and process automation. Avoid companies selling a strong own Vision AI software platform.",
  "runDeepResearch": true,
  "dryRun": false
}
```

Fuer UI und HubSpot sind jetzt besonders wichtig:

- `GET /api/outreach/templates` fuer editierbare Outreach-Templates
- `PUT /api/outreach/templates/:key` fuer Template-Pflege
- `GET /api/outreach/contexts` fuer feste kategoriespezifische Agent-Guidance
- `GET /api/control-plane/bootstrap` fuer Settings, Templates und Category-Contexts in einem Call
- `PUT /api/control/settings` um den globalen `agentContext` im Control Plane Setup zu pflegen

## HubSpot Trigger Konzept

Die einfachste produktionsnahe Variante ist:

1. HubSpot Custom UI oder CRM Card sammelt `targetLeadCount`, `market` und `customGoal`.
2. Ein Workflow oder eine Serverless Action ruft `POST /api/hubspot/workflow-trigger` auf.
3. Das Backend laeuft den Research-Prozess.
4. Ergebnisse werden als Companies, Contacts, Notes oder Custom Objects in HubSpot angelegt.

Das Repo implementiert den Backend-Teil und die Datenstruktur. Die echte HubSpot UI kann als naechster Schritt oben drauf gesetzt werden, sobald die Credentials da sind.

## HubSpot UI-Integration

Der aktuelle Stand ist jetzt in zwei Schichten eingebunden:

1. Eine eingebettete Lead-Konsole unter `GET /hubspot/ui`, die Settings, Template-Pflege und Triggering in einem Screen vereint.
2. Ein HubSpot-Developer-Project-Scaffold unter `hubspot-ui/` mit:
  - `app-hsmeta.json`
  - einer CRM-Card fuer Companies und Contacts
  - einer Settings-Page fuer Defaults und Templates

Wichtige Hinweise fuer das HubSpot-Projekt:

- fuer produktiven Betrieb auf Railway muss `LEAD_AGENT_API_BASE_URL` als feste HTTPS-URL gesetzt werden und in den HubSpot-Projektvariablen genauso hinterlegt sein
- `LEAD_AGENT_SHARED_KEY` schuetzt die eingebettete Konsole und alle produktiven API-Endpunkte; dieselbe Variable muss im Backend und in den HubSpot-Projektvariablen identisch gesetzt werden
- die `permittedUrls` in `hubspot-ui/src/app/app-hsmeta.json` muessen auf eure feste oeffentliche Lead-Agent-URL zeigen
- der alte Private-App-Token fuer das Backend ist bereits in `.env` hinterlegt
- die Card und Settings-Page oeffnen dieselbe eingebettete Konsole, damit Run-Steuerung und Template-Pflege nicht doppelt gepflegt werden

## Railway-Haertung

Vor einem offenen Deploy auf Railway:

- setze `LEAD_AGENT_SHARED_KEY` auf einen langen zufaelligen Wert
- setze `LEAD_AGENT_PUBLIC_BASE_URL` auf eure Railway-URL
- nur `/health` und `/oauth-callback` bleiben ohne Shared-Key erreichbar
- `/hubspot/ui`, `/api/control/*`, `/api/outreach/*`, `/api/lead-jobs/*` und `/api/hubspot/workflow-trigger` verlangen sonst den Header `x-lead-agent-key` oder das `key`-Query-Argument fuer die eingebettete Konsole

## HubSpot-Profilvariablen

Das Developer-Project nutzt jetzt Config Profiles im HubSpot-CLI-Format:

- commitbares Beispiel: `hubspot-ui/src/hsprofile.example.json`
- echte lokale Profile: `hubspot-ui/src/hsprofile.<name>.json` (per `.gitignore` vom Push ausgeschlossen)
- erforderliche Variablen:
  - `LEAD_AGENT_API_BASE_URL`
  - `LEAD_AGENT_SHARED_KEY`

Wird ein Profil verwendet, landen diese Werte sowohl in den `*-hsmeta.json`-Dateien als auch in `context.variables` der UI-Extensions. Upload-Beispiel:

```bash
hs project upload -p leon
```