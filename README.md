# Lead Agent

Dieses Repo beschreibt und implementiert den kompletten ONE-WARE-Lead-Flow vom Start eines Runs bis zum optionalen Writeback nach HubSpot. Die README ist bewusst in zwei Ebenen aufgebaut:

1. oben ein ausfuehrlicher Ueberblick fuer Nicht-Entwickler
2. darunter die technische Dokumentation fuer Entwickler

## GitHub Copilot, lokale Entwicklung und Railway

### Erkanntes Setup

- Framework: Node.js + TypeScript + Express
- Paketmanager: `npm` mit `package-lock.json`
- Dev-Command: `npm run dev`
- Start-Command: `npm start`
- Build-Command: `npm run build`
- Typecheck-Command: `npm run typecheck`
- Test-Command: `npm test`
- Lint: aktuell kein separates Lint-Tool konfiguriert
- Smoke-Test: `npm run smoke`
- Railway: Dockerfile-basiertes Build/Start-Deployment, App bindet an `PORT`

### Lokales Setup

```bash
npm install
cp .env.example .env
```

Pflege in `.env` mindestens diese Werte fuer einen lokalen Start:

- `LEAD_AGENT_SHARED_KEY` mit mindestens 24 Zeichen
- `PORT`, falls du nicht `3000` verwenden willst
- `LEAD_AGENT_PUBLIC_BASE_URL`, wenn Links oder eingebettete UIs auf eine feste URL zeigen sollen

Alle externen APIs sind optional, solange du lokal ohne Live-Credentials arbeitest oder Dry-Run-/Fallback-Pfade verwendest.

### Erforderliche Umgebungsvariablen

Die vollstaendige Vorlage steht in `.env.example`. Fuer GitHub Copilot, CI oder Railway sind besonders relevant:

- `NODE_ENV`
- `PORT`
- `LEAD_AGENT_SHARED_KEY`
- `LEAD_AGENT_PUBLIC_BASE_URL`
- `HUBSPOT_PRIVATE_APP_TOKEN`
- `OPENAI_API_KEY`
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT`
- `EXA_API_KEY`
- `RAILWAY_TOKEN`
- `RAILWAY_PROJECT_ID`

Hinweis zur Benennung: Das Repo verwendet serverseitig `HUBSPOT_PRIVATE_APP_TOKEN`. Wenn ein externes Setup-Dokument `HUBSPOT_ACCESS_TOKEN` nennt, ist das hier nur eine plattformneutrale Alias-Bezeichnung, nicht der eigentliche Runtime-Name.

### GitHub Copilot Coding Agent Setup

1. Lege die benoetigten Repo- oder Environment-Secrets in GitHub an, niemals im Repo.
2. Nutze `.env.example`, `AGENTS.md` und diese README als primäre Copilot-Kontextquellen.
3. Erstelle fuer neue Arbeitsauftraege ein GitHub Issue und weise Copilot zu.
4. Verwende nach Moeglichkeit reproduzierbare Commands aus dem Abschnitt "Validierung".

Ein vorbereitetes Issue-Template fuer Copilot liegt unter `.github/ISSUE_TEMPLATE/copilot-coding-agent.md`.

### Railway Setup

- Runtime-Start: `npm start`
- Build: `npm run build`
- Gesundheitscheck: `GET /health`
- Die App verwendet `PORT` direkt in `src/server.ts`.
- Ein zusaetzliches `railway.json` wurde bewusst nicht hinzugefuegt, weil das Repo bereits erfolgreich ueber Dockerfile bzw. Railway-Build deployt.

Empfohlene Railway-Variablen:

- `NODE_ENV=production`
- `PORT` wird von Railway gesetzt
- `LEAD_AGENT_SHARED_KEY`
- `LEAD_AGENT_PUBLIC_BASE_URL`
- alle benoetigten API-Secrets fuer den gewuenschten Live-Pfad

### HubSpot, OpenAI, Azure und Exa

- HubSpot laeuft serverseitig ueber `src/clients/hubspot.ts` mit `HUBSPOT_PRIVATE_APP_TOKEN`.
- OpenAI Web Search laeuft serverseitig ueber `src/clients/openai-web-search.ts` mit `OPENAI_API_KEY`.
- Azure OpenAI laeuft serverseitig ueber `src/clients/azure-openai.ts` mit `AZURE_OPENAI_*`.
- Exa laeuft serverseitig ueber `src/clients/exa-search.ts` mit `EXA_API_KEY`.
- Im Frontend wurden keine dieser API-Secrets referenziert; einzig `LEAD_AGENT_SHARED_KEY` wird bewusst als Server-Zugriffsschutz fuer die eingebettete HubSpot-Konsole verwendet.

### Validierung

```bash
npm install
npm test
npm run typecheck
npm run build
npm run smoke
```

Falls spaeter ein echtes Lint-Tool eingefuehrt wird, sollte `npm run lint` erst dann dokumentiert und in PRs verlangt werden.

### Troubleshooting

- Start bricht sofort ab: pruefe `LEAD_AGENT_SHARED_KEY`; der Server validiert Env-Werte jetzt mit klarer Fehlermeldung beim Start.
- `npm run smoke` scheitert: pruefe, ob `dist/` vorher mit `npm run build` erzeugt wurde.
- HubSpot UI laedt nicht: pruefe `LEAD_AGENT_PUBLIC_BASE_URL`, `LEAD_AGENT_SHARED_KEY` und das lokale oder HubSpot-CLI-Profil.
- Copilot oder CI kann nicht deployen: hinterlege `RAILWAY_TOKEN` und `RAILWAY_PROJECT_ID` nur in GitHub oder Railway Secrets, nicht im Repo.
- API-Aufrufe liefern 401, 403 oder 429: verwende Sandbox- oder Dev-Credentials und pruefe Quotas, niemals Produktionsdaten ohne explizite Freigabe.

## Gesamtueberblick fuer Nicht-Entwickler

### Was dieses System eigentlich macht

Der Lead Agent ist kein normales Tool zum Einsammeln von moeglichst vielen Firmennamen. Er ist ein qualifizierender Arbeitsablauf, der aus einer Suchidee Schritt fuer Schritt eine kleinere, bessere und begruendete Zielliste macht.

Das Ziel ist nicht Masse, sondern Relevanz. Das System soll moeglichst frueh erkennen, welche Suchrichtungen und welche Firmen fuer ONE WARE unspannend sind, damit Zeit und Aufmerksamkeit nur in die besten Kandidaten fliessen.

Am Ende entsteht kein roher Export, sondern eine vorbewertete Arbeitsgrundlage fuer Vertrieb, Business Development und Partneraufbau.

### Welches Geschaeftsproblem geloest wird

ONE WARE braucht keine beliebige Liste von "AI Companies", sondern Firmen, bei denen ein realistischer Zugang fuer ONE WARE besteht. Dazu gehoeren vor allem:

- Integratoren mit echter Projekt- und Umsetzungskompetenz
- industrielle Endkunden mit plausiblem Nutzen fuer Vision AI, Qualitaetskontrolle oder Automatisierung
- Maschinenbauer oder Hardware-nahe Firmen, bei denen AI eine Produkterweiterung sein kann
- Partner- oder Embed-Faelle, bei denen ONE WARE technologisch sinnvoll andocken kann

Das Problem im Alltag ist normalerweise immer gleich:

- zu viele Firmen sind oberflaechlich interessant, aber in Wirklichkeit unpassend
- manuell kostet die Einordnung zu viel Zeit
- tiefe Recherche wird oft auf zu viele schwache Kandidaten verteilt
- Outreach wird haeufig zu frei und zu wenig zielgruppenscharf erstellt

Genau diese vier Probleme soll der Lead Agent reduzieren.

### Was ein Nutzer oben hinein gibt

Fachlich startet ein Lauf immer mit wenigen Leitplanken, zum Beispiel:

- in welchem Markt gesucht werden soll
- wie viele Leads am Ende benoetigt werden
- welche Segmente im Fokus stehen
- ob eher Kunden, Partner oder Integratoren gesucht werden
- ob Ergebnisse nur zur Vorschau dienen oder direkt in HubSpot landen sollen

Wichtig ist: Man beschreibt also eher die Richtung und das Ziel. Das System uebernimmt danach die eigentliche Pruefung, Verdichtung und Priorisierung.

### Was im Hintergrund waehrend eines Laufs passiert

Fachlich laeuft das System in mehreren Schritten:

1. Es startet nicht mit einer einzigen Suche, sondern mit mehreren Suchrichtungen.
2. Diese Suchrichtungen werden zuerst nur mit kleinen Testmengen geprueft.
3. Schlechte Richtungen werden frueh gestoppt, damit sie keine weitere Zeit und Kosten verbrauchen.
4. Gute Richtungen werden ausgebaut.
5. Die gefundenen Firmen werden eingeordnet: passend, unpassend oder unklar.
6. Die besseren Firmen bekommen eine tiefere Geschaefts- und Relevanzpruefung.
7. Fuer die besten Firmen werden Ansprachevorschlaege vorbereitet.
8. Am Ende werden die qualifizierten Ergebnisse gesammelt und bei Bedarf nach HubSpot geschrieben.

Der wichtigste Unterschied zu einem klassischen Lead-Export ist also: Das System bewertet und entscheidet unterwegs immer wieder neu, statt eine grosse unpruefte Liste durchzureichen.

### Wie man sich den Arbeitsstil des Agents vorstellen kann

Der Agent arbeitet eher wie ein strenger Analyst als wie eine Suchmaschine.

Er versucht nicht, moeglichst schnell positive Treffer zu bestaetigen, sondern stellt immer wieder kritische Fragen:

- Ist diese Suchrichtung ueberhaupt sinnvoll?
- Sind die ersten Firmen aus dieser Richtung wirklich brauchbar?
- Ist die Firma wirklich im Zielmarkt oder sieht sie nur oberflaechlich passend aus?
- Ist das eher ein echter Fit fuer ONE WARE oder nur ein loses AI-/Tech-Signal?
- Lohnt sich hier tiefere Recherche oder nicht?

Damit wird das System besonders dann wertvoll, wenn der Markt gross, verrauscht oder schwer sauber zu filtern ist.

### Was am Ende konkret herauskommt

Ein guter Lauf liefert in der Regel ein fertiges Arbeitsset fuer das Team. Dazu gehoeren typischerweise:

- eine priorisierte Liste geeigneter Firmen
- eine kurze Begruendung, warum eine Firma relevant ist
- eine Kennzeichnung von Risiken, Unsicherheiten oder Ausschlussgruenden
- vorbereitete Research-Zusammenfassungen
- Vorschlaege fuer LinkedIn, E-Mail und Telefonansprache
- optional ein strukturierter Eintrag in HubSpot

Das Team bekommt also nicht nur Namen, sondern bereits eine erste fachliche Vorarbeit.

### Was das Team dadurch gewinnt

Der Nutzen liegt vor allem in drei Bereichen:

1. Bessere Auswahl: Statt breite Listen manuell zu sichten, startet das Team mit vorqualifizierten Kandidaten.
2. Schnellere Priorisierung: Gute Firmen werden frueher sichtbar, schwache Kandidaten frueher aussortiert.
3. Konsistentere Ansprache: Outreach entsteht nicht jedes Mal neu aus dem Bauch, sondern aus einer strukturierten Logik.

### Welche Rolle die externen Systeme spielen

Aus fachlicher Sicht arbeiten drei externe Bausteine zusammen:

- Web Scraper und AI Agent fuer die Firmensuche und Kontaktfindung ueber oeffentliche Quellen
- Azure OpenAI oder Azure AI Foundry fuer die intelligenten Bewertungs- und Research-Schritte
- HubSpot als Steuerungs-, Anzeige- und Zielsystem fuer Ergebnisse

Fuer die Kontaktfindung gilt: Zuerst werden oeffentliche Firmenseiten gecrawlt und mit einem AI Agent ausgewertet. Anschliessend wird eine Browser-Suche mit LinkedIn-Filter eingesetzt, um relevante Personen auf LinkedIn fuer die jeweilige Firma zu finden.

Fuer Nicht-Entwickler ist vor allem wichtig: Diese Systeme werden nicht isoliert benutzt, sondern als zusammenhaengender Entscheidungsprozess.

### Was das System bewusst nicht ist

Damit die Erwartung klar bleibt:

- es ist kein Massen-Scraper fuer moeglichst viele Kontakte
- es ist kein generischer Chatbot fuer beliebige Sales-Recherche
- es ist kein vollautonomes System, das ohne fachliche Zielsetzung automatisch perfekte Leads erzeugt
- es ist kein Ersatz fuer finale menschliche Bewertung bei strategisch wichtigen Accounts

Es ist vielmehr ein Qualifizierungs- und Vorbereitungswerkzeug, das die Qualitaet der ersten Pipeline-Stufen deutlich verbessern soll.

### Wann ein Lauf als gut gelten sollte

Ein guter Lauf ist nicht der mit den meisten Firmen, sondern der mit dem besten Verhaeltnis aus:

- relevanten Treffern
- klarer Begruendung
- wenig Streuverlust
- brauchbarer Folgeansprache

Wenn also am Ende weniger Firmen herauskommen, diese aber deutlich sauberer passen und schneller bearbeitet werden koennen, dann arbeitet das System genau wie beabsichtigt.

### Kurzform in einem Satz

Der Lead Agent ist ein qualifizierender ONE-WARE-Workflow, der Suchrichtungen testet, schlechte Treffer frueh stoppt, gute Firmen fachlich verdichtet, eine passende Ansprache vorbereitet und Ergebnisse bei Bedarf nach HubSpot uebergibt.

## Technische Dokumentation fuer Entwickler

### Technischer Einstieg

Der Laufzeitkern sitzt in:

- `src/server.ts`: HTTP-Entrypoints, Request-Validierung, Shared-Key-Schutz, Control-Plane-Endpunkte
- `src/agents/lead-pipeline.ts`: eigentliche Orchestrierung des Flows
- `src/prompting/one-ware-playbook.ts`: Hauptkontext, Kategorieregeln, Segmentlogik, Outreach-Templates
- `src/clients/*.ts`: externe API-Pfade und Fallback-Ketten
- `src/control-plane.ts`: persistierte Defaults, Templates, Learning und letzte Runs

### End-to-End Flow im Detail

### 1. Trigger und Request-Aufnahme

Es gibt drei praktische Einstiegspunkte:

- `POST /api/lead-jobs/preview`: baut nur die vorgeschlagenen Filter
- `POST /api/lead-jobs/run`: fuehrt den Run synchron aus und gibt das Resultat direkt zurueck
- `POST /api/hubspot/workflow-trigger`: startet den Run asynchron fuer HubSpot/UI

Zusatzoberflaechen:

- `GET /hubspot/ui`: eingebettete Lead-Konsole aus `public/hubspot-ui/index.html`
- `hubspot-ui/`: HubSpot Developer Project mit CRM Card und Settings-Page

Der Server validiert Requests mit `zod` in `src/server.ts`. Vor dem Run werden Body-Werte mit den gespeicherten Control-Plane-Settings zusammengefuehrt. Genau dort wird entschieden, welche Default-Werte aus `data/lead-agent-settings.json` gelten, wenn der Request nicht alles selbst mitbringt.

Wichtige Request-Felder:

- `targetLeadCount`
- `market`
- `mainContext`
- `searchStrategyContext`
- `prequalification`
- `executionContexts`
- `targetCategories`
- `creditLessMode`
- `runDeepResearch`
- `dryRun`
- `syncToHubSpot`
- `earlyStopEnabled`
- `earlyStopReviewCount`
- `earlyStopThreshold`

### 2. Settings-, Template- und Learning-Layer

Bevor der Agent operative Logik ausfuehrt, zieht er Kontext aus `ControlPlaneStore` in `src/control-plane.ts`.

Persistierte Dateien unter `data/`:

- `lead-agent-settings.json`: globale Defaults fuer Runs
- `outreach-templates.json`: editierbare Templates
- `lead-agent-learning.json`: Feedback, Filterperformance, Search History
- `latest-lead-run.json`: letzter kompletter Lauf mit Ergebniszusammenfassung
- `latest-outreach-review.json`: Platz fuer Review-/UI-nahe Artefakte

Das ist wichtig, weil der Agent nicht nur vom aktuellen Request lebt. Ein Run verwendet immer die Kombination aus:

1. HTTP-Request
2. gespeicherten Settings
3. festem ONE-WARE-Playbook
4. historischem Learning aus frueheren Runs

### 3. Filteraufbau: Baseline zuerst, KI danach

Der Filter-Startpunkt ist bewusst deterministisch:

- `src/filters.ts` liefert die Baseline-Filters fuer Integratoren, Industriekunden, Kamerahersteller, Maschinenbauer und Plattformen.
- `buildSuggestedFilters(market, customGoal)` erweitert diese Baseline nur um Markt- und Zielnotizen.

Danach kann die Pipeline die Filters erweitern oder umsortieren:

1. `LeadPipelineAgent.getSuggestedFilters()` zieht die Baseline.
2. `AzureOpenAIClient.generateSuggestedFilters()` versucht eine KI-Optimierung.
3. Innerhalb dieses Clients gilt die Fallback-Kette:
   - zuerst `FoundryAgentsClient.generateSuggestedFilters()`, wenn Foundry konfiguriert und `FOUNDRY_USE_AGENT_FILTERS=true`
   - sonst Azure OpenAI Chat, wenn Azure konfiguriert ist
   - sonst unveraenderte Baseline-Filters
4. Danach werden die Filter mit Learning-Signalen neu priorisiert.

Das Learning beeinflusst also nicht nur Reporting, sondern die Reihenfolge der Filterbearbeitung direkt.

### 4. Firmenquelle: Web Scraper und AI Agent

Die Firmenbeschaffung laeuft ausschliesslich ueber den `WebSearchAgent` in `src/clients/web-search-agent.ts`.

Der Pfad wird zur Laufzeit so entschieden:

1. `dryRun=true`
   - es werden synthetische Firmensamples erzeugt
   - keine externe API wird aufgerufen
2. normaler Live-Pfad
   - Firmenfindung ueber Web Scraper und AI Agent (`OpenAIWebSearchClient`, `OpenCrawlerSearchClient`, `ExaSearchClient`)
   - je nach `companySearchMode` wird `internet_research`, `open_crawler_search` oder `exa_search` verwendet

Duerftige Beschreibungen werden mit `summarizeCompany()` nachangereichert, ebenfalls ueber den Web-Search-Pfad.

### 5. Prequalification: lokale Regeln vor LLM vor Segment-Filterung

Die Firmenklassifikation ist mehrstufig aufgebaut:

1. `LeadPipelineAgent.prequalifyLocally()`
   - harte Guards fuer irrelevante Profile
   - fruehe Erkennung offensichtlicher Non-ICP-Segmente
   - einfache Produkt-vs-Service-Korrekturen
2. `AzureOpenAIClient.categorizeCompany()`
   - zuerst deterministische Checks aus Beschreibung plus Learning
   - dann optional Foundry Qualification Agent
   - sonst Azure OpenAI Chat
   - sonst Dry-Run-Heuristik
3. `LeadPipelineAgent.enforceIndustrialFit()`
   - nachgelagerte Korrektur, falls ein Modell zu positiv oder in die falsche Kategorie klassifiziert

Wichtig: die Kategorieentscheidung wird nicht blind aus dem Filternamen uebernommen. Der Code versucht explizit, den Firmenarchetyp erst objektiv zu erkennen und dann erst gegen die aktiven Zielkategorien zu pruefen.

### 6. Early Stop und Filterbewertung

Der wirtschaftliche Kern des Systems ist der Fruehabbruch in `LeadPipelineAgent.run()`:

1. Pro Filter wird zuerst nur eine Vorprobe geholt.
2. Die Vorprobe wird kategorisiert.
3. `evaluateFilter()` berechnet:
   - `relevantCount`
   - `relevanceRatio`
   - `categoryBreakdown`
   - `recommendation`
4. Liegt das Signal unter `earlyStopThreshold`, wird der Filter frueh beendet.
5. Optional versucht `AzureOpenAIClient.reviseSearchFilter()` genau einen ueberarbeiteten Retry-Filter.

Der Standard im Code ist konservativer als die alte README:

- `DEFAULT_EARLY_STOP_REVIEW_COUNT = 15`
- `DEFAULT_EARLY_STOP_THRESHOLD = 0.5`

Das bedeutet: Standardmaessig muss ein Filter in den ersten 15 Firmen mindestens 50 Prozent relevantes Signal liefern, sonst wird er nicht weiter skaliert.

### 7. Expansion, Top-Up und Deduplizierung

Wenn ein Filter die Vorprobe besteht, erweitert die Pipeline schrittweise weitere Seiten.

Dabei greifen mehrere Sicherungen:

- bereits negativ markierte Firmen aus Learning werden ausgeschlossen
- bereits gesehene Firmen werden nicht erneut bearbeitet
- Shortlist-Eintraege werden ueber Firmen-Key dedupliziert
- falls nach dem Hauptlauf zu wenig Kandidaten uebrig sind, fuellt `topUpWithWebDiscovery()` mit Web-Search-Ergebnissen auf
- vor dem finalen Ergebnis werden bestehende HubSpot-Domains entfernt

Die Shortlist ist also das Ergebnis aus Probe + Expansion + Web Top-Up + CRM-Dedupe.

### 8. Research und Outreach-Ableitung

Research wird nur gebaut, wenn `dryRun` nicht aktiv ist. Danach gilt eine wichtige Feinheit:

- `runDeepResearch !== false` aktiviert Web-Evidence im Research-Pfad
- `runDeepResearch = false` deaktiviert nur die Web-Recherche, nicht den gesamten Brief-Aufbau

Der Brief wird ueber `AzureOpenAIClient.buildResearchBrief()` erzeugt. Die Reihenfolge ist:

1. Foundry Research Agent, wenn aktiviert
2. sonst Azure OpenAI Chat
3. bei Ausfall Fallback-Brief aus Template + bekannter Firmenspur

Falls Web Research aktiv ist, kommt der Kontext ueber `WebSearchAgent.buildResearchContext()`, also ueber den OpenAI-Responses-Web-Search-Pfad.

Der Output enthaelt unter anderem:

- `overview`
- `qualificationSummary`
- `qualifyingSignals`
- `riskFlags`
- `rankings.customer`
- `rankings.serviceProvider`
- `rankings.partner`
- `businessPotentialEUR`
- `targetIndustry`
- `productsOffered`
- `linkedInMessage`
- `emailSubject`
- `emailBody`
- `phoneScript`
- `eventIdea`

### 9. Contact Discovery

Nach der Firmenauswahl sammelt die Pipeline oeffentlich sichtbare Kontakte. Diese Logik sitzt direkt im `HubSpotClient`.

Die Kontaktfindung laeuft in zwei Stufen:

1. **Web Scraper**: `findPublicContacts()` crawlt die Firmenseite
   - Root-Domain der Firma normalisieren
   - relevante Seiten wie `contact`, `kontakt`, `impressum`, `about`, `team`, `management` crawlen
   - oeffentliche Firmen-E-Mails und Telefonnummern extrahieren
   - nur Domain-passende Firmenmails behalten
   - Low-Value- oder generische Mailboxen abwerten

2. **Browser-Suche mit LinkedIn-Filter**: Ein AI Agent fuehrt anschliessend Browser-Suchen mit `site:linkedin.com/in` durch, um Personen auf LinkedIn fuer die jeweilige Firma zu finden. Dabei werden Entscheidungstraeger priorisiert (CEO, CTO, Head of Engineering usw.).

### 10. HubSpot-Sync

Der Writeback passiert ueber `HubSpotClient.syncQualifiedCompanies()`.

Wesentliche Eigenschaften:

- bei `dryRun` oder fehlendem HubSpot-Token wird nichts geschrieben
- vorhandene Company- und Contact-Properties werden dynamisch geladen
- Companies werden ueber Domain oder Name geupsert
- Contacts werden ueber E-Mail geupsert
- Contacts werden anschliessend an Companies assoziiert

Der Sync schreibt nicht blind alles, sondern nur Properties, die im Portal auch wirklich existieren.

### 11. Persistenz nach dem Run

Nach jedem Lauf werden mehrere Schichten aktualisiert:

- Filter-Evaluationen
- Search History
- letzter kompletter Lead-Run
- abgeleitete Generated Lead Records fuer UI und Review

Dadurch kann das System den naechsten Run mit historischem Signal priorisieren, auch wenn derselbe Operator den Kontext nicht jedes Mal neu formuliert.

### Prompt- und Kontextschichten

Die Prompt-Logik ist zentral in `src/prompting/one-ware-playbook.ts` gebuendelt. Das Repo arbeitet nicht mit einem einzelnen Masterprompt, sondern mit mehreren Schichten.

### 1. Main Context

`ONE_WARE_PROMPT_CONTEXT` definiert das Grundnarrativ:

- was ONE WARE verkauft
- welche Probleme geloest werden
- worauf die Bewertung ausgerichtet wird

Dieser Block fliesst praktisch in alle intelligenten Stufen ein.

### 2. Search Strategy Context

`buildSearchStrategyContextBlock()` kombiniert:

- Main Context
- Search-Strategy-Kontext

Dieser Block steuert die Filtergenerierung und Filterrevision. Er wird von Azure- und Foundry-Filterpfaden verwendet.

### 3. Prequalification Context

`buildPrequalificationContextBlock()` kombiniert:

- Main Context
- globale Prequalification-Regeln
- category-spezifische Zusatzregeln
- aktive Zielkategorien des Runs
- optionale Operator-Overrides aus den Settings

Dieser Block steuert die Klassifikation.

### 4. Execution Context

`buildExecutionContextBlock()` baut pro Kategorie einen Research-/Outreach-Kontext aus:

- `researchPriorities`
- `outreachPriorities`
- `personalizationRules`
- `avoidSignals`

Dieser Block steuert die Research-Briefs und die kontrollierte Personalisierung.

### 5. Outreach Templates

Die Outreach-Texte liegen als feste Segment-Templates ebenfalls in `src/prompting/one-ware-playbook.ts` und koennen ueber die Control Plane in `data/outreach-templates.json` ueberschrieben werden.

Die Templates sind segmentiert fuer:

- `integrator_vision_industrial_ai`
- `integrator_general_ai`
- `integrator_relevant_focus`
- `industrial_end_customer_scaled`
- `camera_manufacturer_partner`
- `machine_builder_ai_enablement`
- `software_platform_embedding`

Wichtig: Das System soll Outreach nicht frei neu schreiben, sondern aus einem festen Template heraus personalisieren.

### 6. Learning als Prompt-Zusatz

Historische Filterperformance und frueheres Feedback werden in mehreren KI-Stufen als Zusatzkontext eingeblendet. Learning ist damit ein echter Eingabekanal fuer die Strategie, nicht nur eine Reporting-Datei.

### Welche API wo verwendet wird

| API / Dienst | Datei | Aufgabe | Wann aktiv |
| --- | --- | --- | --- |
| Express | `src/server.ts` | HTTP-API, UI-Auslieferung, Shared-Key-Schutz | immer |
| OpenAI Responses Web Search | `src/clients/openai-web-search.ts` | Firmenfindung, Kontaktfindung, Firmen-Summary, Research-Evidence | wenn `OPENAI_WEB_SEARCH_ENABLED=true` und `OPENAI_API_KEY` vorhanden |
| Azure OpenAI | `src/clients/azure-openai.ts` | Filterstrategie, Klassifikation, Research-Briefs, Filterrevision | wenn `AZURE_OPENAI_API_KEY` und `AZURE_OPENAI_ENDPOINT` vorhanden |
| Azure AI Foundry Agents | `src/clients/foundry-agents.ts` | optionale Agenten fuer Filter, Qualification, Research und Kontaktfindung | wenn `FOUNDRY_PROJECT_ENDPOINT` gesetzt und jeweilige `FOUNDRY_USE_AGENT_*` Flags aktiv sind |
| HubSpot CRM API | `src/clients/hubspot.ts` | Company/Contact Upsert und Association | wenn `HUBSPOT_PRIVATE_APP_TOKEN` vorhanden und Sync nicht im Dry-Run ist |

### Tatsaechliche Fallback-Ketten

### Firmenfindung

1. Dry-Run-Sample
2. Web Scraper und AI Agent (internet_research, open_crawler_search oder exa_search)

### Filterstrategie

1. Baseline aus `src/filters.ts`
2. Foundry Filter Agent
3. Azure OpenAI Chat
4. Baseline ohne KI-Erweiterung

### Klassifikation

1. lokale Guards
2. deterministische Klassifikation
3. Foundry Qualification Agent
4. Azure OpenAI Chat
5. Dry-Run-Heuristik

### Research

1. Foundry Research Agent
2. Azure OpenAI Chat
3. Fallback-Research aus Template + vorhandenen Facts

### Wichtige Dateien und ihr Zusammenspiel

| Datei | Rolle |
| --- | --- |
| `src/index.ts` | startet den Express-Server |
| `src/server.ts` | API, Payload-Merge, Auth, UI-Routing |
| `src/agents/lead-pipeline.ts` | komplette Ablaufsteuerung des Agenten |
| `src/control-plane.ts` | Settings, Templates, Learning, Latest Run |
| `src/filters.ts` | deterministische Basisfilter |
| `src/types.ts` | gemeinsame Vertragsflaechen fuer Requests, Ergebnisse und Persistenz |
| `src/prompting/one-ware-playbook.ts` | Main Context, Prequalification, Execution Contexts, Templates |
| `src/clients/company-search.ts` | Firmenbeschaffung ueber Web Scraper und AI Agent |
| `src/clients/azure-openai.ts` | zentraler LLM-Orchestrator fuer Chat-basierte Stufen |
| `src/clients/foundry-agents.ts` | optionaler Agentenpfad fuer Azure AI Foundry |
| `src/clients/openai-web-search.ts` | OpenAI Responses Web Search fuer Firmenebene |
| `src/clients/web-search-agent.ts` | duenne Fassade ueber OpenAI Web Search |
| `src/clients/hubspot.ts` | HubSpot Upsert, Contact Discovery, Associations |
| `hubspot-ui/src/app/cards/LeadAgentCard.tsx` | HubSpot CRM Card |
| `hubspot-ui/src/app/settings/LeadAgentSettings.tsx` | HubSpot Settings-UI |
| `public/hubspot-ui/index.html` | eingebettete Lead-Konsole |

### HTTP-Endpunkte

### Oeffentlich bzw. lokal offen

- `GET /health`
- `GET /oauth-callback`

### Laufsteuerung

- `POST /api/lead-jobs/preview`
- `POST /api/lead-jobs/run`
- `POST /api/hubspot/workflow-trigger`
- `GET /api/control/run-status`
- `GET /api/control/latest-lead-run`

### Settings und Bootstrap

- `GET /api/config/readiness`
- `GET /api/control-plane/bootstrap`
- `GET /api/control/settings`
- `PUT /api/control/settings`

### Templates und Kontexte

- `GET /api/filter-presets`
- `GET /api/outreach/templates`
- `PUT /api/outreach/templates/:key`
- `GET /api/outreach/contexts`

### Learning

- `GET /api/control/learning`
- `POST /api/control/learning/feedback`

### UI-Routen

- `GET /hubspot`
- `GET /hubspot/ui`

### Wichtige Umgebungsvariablen

### Grundbetrieb

- `PORT`
- `LEAD_AGENT_SHARED_KEY`
- `LEAD_AGENT_PUBLIC_BASE_URL`
- `DEFAULT_MARKET`
- `DEFAULT_TARGET_LEADS`

### OpenAI Web Search

- `OPENAI_API_KEY`
- `OPENAI_WEB_SEARCH_ENABLED`
- `OPENAI_WEB_SEARCH_MODEL` default `gpt-5.4-mini`

### Azure OpenAI

- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_DEPLOYMENT` default `gpt-5.4-mini`
- `AZURE_AI_CLASSIFICATION_CONCURRENCY` default `6`
- `AZURE_OPENAI_API_VERSION`

### Azure AI Foundry

- `FOUNDRY_PROJECT_ENDPOINT`
- `FOUNDRY_MODEL_DEPLOYMENT`
- `FOUNDRY_BING_CONNECTION_NAME`
- `FOUNDRY_USE_AGENT_FILTERS`
- `FOUNDRY_USE_AGENT_QUALIFICATION`
- `FOUNDRY_USE_AGENT_RESEARCH`

### HubSpot

- `HUBSPOT_PRIVATE_APP_TOKEN`
- `HUBSPOT_BASE_URL`

### Betriebslogik, die man leicht falsch versteht

1. `dryRun=true` bedeutet nicht nur "kein HubSpot Sync", sondern schaltet praktisch alle externen Live-Pfade auf Mock/Fallback um.
2. `runDeepResearch=false` bedeutet nicht "kein Research", sondern "Research ohne Web-Evidence".
3. `creditLessMode` ist ein Legacyfeld und hat keine Funktion mehr; die Firmenfindung laeuft immer ueber Web Scraper und AI Agent.
4. Learning beeinflusst Priorisierung und Prompting, nicht nur das Reporting.
5. Contact Discovery laeuft in zwei Stufen: zuerst Web Scraper ueber oeffentliche Firmenseiten, dann Browser-Suche mit LinkedIn-Filter.
6. Der HubSpot-Sync ist property-aware und schreibt nur Felder, die im Zielportal existieren.

### Lokal starten

```bash
npm install
npm run check
npm run dev
```

Produktionsbuild:

```bash
npm run build
npm start
```

### Beispiel-Request

```bash
curl -X POST http://localhost:3000/api/lead-jobs/run \
  -H "Content-Type: application/json" \
  -H "x-lead-agent-key: <shared-key>" \
  -d '{
    "targetLeadCount": 25,
    "market": "Germany",
    "mainContext": "Prioritize industrial software integrators and QC-relevant manufacturing accounts.",
    "searchStrategyContext": "Bias toward delivery-led integrators before broad AI branding.",
    "targetCategories": [
      "integrator_vision_industrial_ai",
      "industrial_end_customer_scaled",
      "machine_builder_ai_enablement"
    ],
    "creditLessMode": false,
    "runDeepResearch": true,
    "dryRun": false,
    "syncToHubSpot": false,
    "earlyStopEnabled": true,
    "earlyStopReviewCount": 15,
    "earlyStopThreshold": 0.5
  }'
```

### Dokumente fuer Vertiefung

- `docs/workflow-blueprint.md`: fruehere fachliche Skizze des Prozessmodells
- `docs/prompting-guide.md`: knapper Guide zur Prompt-Ausrichtung
- `docs/integration-checklist.md`: Integrationshinweise

Die README oben bildet jetzt den tatsaechlichen Codepfad ab. Fuer neue Features sollte zuerst geprueft werden, ob die Aenderung den Orchestrierungsfluss in `src/agents/lead-pipeline.ts`, die Kontextschichten in `src/prompting/one-ware-playbook.ts` oder die API-Fallbacks in `src/clients/` veraendert.

## Zielbild

Der Workflow ist in vier Stufen aufgeteilt:

1. Filter Agent: erzeugt und testet Filter-Sets fuer relevante Firmenlisten.
2. Pre-Categorization Agent: bewertet 50er-Samples und looped mit neuen Filterideen zurueck.
3. Deep Research Agent: erstellt Firmen-Overview, finale Qualifikation und Outreach-Vorbereitung fuer LinkedIn, E-Mail und Telefon.
4. HubSpot Sync Agent: schreibt qualifizierte Ergebnisse in HubSpot.

## Was schon vorbereitet ist

- Express API fuer Triggering aus HubSpot oder einem internen Operator-UI
- vordefinierte Filter-Presets fuer eure ICP-Hypothesen
- Kategorien fuer die Qualifikation
- ein zentraler One-WARE-Prompt- und Template-Layer fuer Qualifizierung und Outreach
- orchestrierte Pipeline mit Dry-Run-Modus ohne API-Keys
- vorbereitete Stellen fuer Azure- und HubSpot-Clients

## Beispielablauf

1. HubSpot oder ein internes UI sendet `targetLeadCount`, `market`, optionale `prequalificationContext` und `targetCategories` an `POST /api/hubspot/workflow-trigger`.
2. Das Backend erzeugt passende Filter-Vorschlaege.
3. Fuer jedes Filter-Set werden erst 5 bis 15 Firmen schnell angeprueft; nur bei gutem Signal wird bis 50 erweitert.
4. Eine Vorqualifikation zaehlt relevante Kategorien, bricht schwache Filter frueh ab und bewertet die Filterqualitaet.
5. Die besten Filter-Sets werden fuer Deep Research und Outreach Preparation priorisiert.
6. Qualifizierte Firmen oder Kontakte werden an HubSpot uebergeben.

## Relevante Kategorien

- integrator_vision_industrial_ai
- integrator_general_ai
- integrator_relevant_focus
- industrial_end_customer_scaled
- camera_manufacturer_partner
- machine_builder_ai_enablement
- software_platform_embedding
- irrelevant
- other

## API-Endpunkte

- `GET /health`
- `GET /api/config/readiness`
- `GET /api/filter-presets`
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
- `prequalificationContext`: optionaler Kontext fuer den Vorsortierungs-Agenten

Prompt- und Template-Logik:

- die Qualifikation folgt jetzt explizit dem ONE-WARE-ICP aus Software-Integratoren, Industriekunden und Hardwarepartnern
- VCs, Banken, reine Berater und direkte konkurrierende Plattformprofile werden aktiv abgewertet oder ausgeschlossen
- Outreach wird nicht mehr frei neu geschrieben, sondern pro Segment aus festen Templates mit kontrollierter Personalisierung abgeleitet
- pro Firmenkategorie gibt es jetzt eigenen Agent-Kontext fuer Research-Prioritaeten, Outreach-Prioritaeten, Personalisierungsregeln und No-Go-Signale
- der Vorsortierungs-Kontext kann ueber `prequalificationContext` aus HubSpot oder dem Operator-UI erweitert werden

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

- HubSpot private app token
- Azure OpenAI endpoint, key und deployment name
- optional: Foundry project endpoint fuer agentische Filteroptimierung, Vorqualifikation und Deep Research mit Web Search oder Bing Grounding
- optional: Foundry Bing connection name, wenn statt allgemeinem Web Search die neue Grounding-with-Bing-Resource verwendet werden soll
- optional: OpenAI API key fuer Web-basierte Firmenbeschaffung und Kontaktfindung

## Foundry Agent Setup

Das Repo unterstuetzt jetzt optional drei rollenbasierte Foundry-Agents auf der bestehenden Pipeline:

1. Filter Strategy Agent: optimiert Suchfilter fuer euren ICP.
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

## Firmen-Web-Search

Die Pipeline nutzt ausschliesslich den OpenAI-Responses-Web-Search-Pfad fuer Firmendaten und Kontaktfindung.

Wichtige Regeln:

1. Es werden nur organisationsbezogene Daten uebergeben, zum Beispiel Firmenname, Website, Land, Kurzbeschreibung, Kategorie und Filterdefinitionen.
2. Es werden keine personenbezogenen Daten an OpenAI-Web-Search geschickt, also keine Namen, E-Mails, Telefonnummern oder Profil-URLs von Personen.
3. Kontaktfindung laeuft zuerst ueber Web-Scraper der Firmenseite, dann ueber Browser-Suche mit LinkedIn-Filter.

Relevante Umgebungsvariablen:

- `OPENAI_API_KEY`
- `OPENAI_WEB_SEARCH_ENABLED=true`
- `OPENAI_WEB_SEARCH_MODEL=gpt-5.4-mini`

Wichtige Betriebshinweise:

- fuer den kostenarmen Standardpfad sind `gpt-5.4-mini` fuer OpenAI-Web-Search und nach Moeglichkeit auch fuer Azure-/Foundry-Deployments hinterlegt
- die aktuelle Implementierung unter `src/clients/foundry-agents.ts` authentifiziert sich mit `DefaultAzureCredential`; fuer echten Betrieb braucht der Runtime-Host deshalb eine funktionierende Entra-ID-Credential-Kette und die Rolle `Azure AI User` auf der Foundry-Resource bzw. dem Projektpfad

## HubSpot- und Operator-Kontext

Ihr koennt jetzt pro Run einen freien `agentContext` mitsenden. Dieser Text wird in drei Phasen verwendet:

1. fuer die Optimierung der Suchfilter
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
- lokale Tokens und HubSpot-Profile duerfen nur in unversionierten Dateien wie `.env` oder `hubspot-ui/src/hsprofile.<name>.json` liegen
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