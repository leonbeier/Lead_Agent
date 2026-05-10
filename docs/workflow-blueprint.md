# Workflow Blueprint

## 1. Trigger in HubSpot

Ziel: Ein User startet den Prozess direkt aus HubSpot und gibt nur die minimalen Parameter vor.

Empfohlene Inputs:

- `targetLeadCount`
- `market`
- `customGoal`
- `runDeepResearch`

Produktionsnahe Umsetzungsoptionen:

1. HubSpot CRM Card oder UI Extension mit Formular.
2. HubSpot Workflow Custom Code Action.
3. HubSpot Button oder Internal App, die den API-Call an dieses Backend ausloest.

Minimaler Backend-Call:

```http
POST /api/hubspot/workflow-trigger
Content-Type: application/json

{
  "targetLeadCount": 50,
  "market": "DACH",
  "customGoal": "Find machine builders and integrators where Vision AI is commercially relevant",
  "runDeepResearch": true,
  "dryRun": true
}
```

## 2. Apollo Filter Agent

Der erste Agent erzeugt Test-Hypothesen fuer Apollo.

Empfohlene Start-Cluster:

1. Software Integrators in industrial automation.
2. AI software integrators with computer vision keywords.
3. Machine builders with quality inspection or inline inspection language.
4. Industrial camera vendors without clear AI software differentiation.

Pro Cluster wird zuerst nur eine kleine Vorprobe von 5 bis 15 Firmen gezogen und kategorisiert. Nur wenn diese Vorprobe genug Signal hat, wird bis auf 50 erweitert. So spart ihr API-Kosten, Research-Zeit und KI-Tokens bei schlechten Filtern.

## 3. Pre-Categorization Agent

Dieser Schritt nimmt zuerst die ersten 5 bis 15 Firmen pro Filterset und ordnet sie einer Kategorie zu. Nur Filter mit gutem Fruehsignal werden danach auf 50 Firmen erweitert.

Zielkategorien:

- `software_integrator`
- `ai_software_integrator`
- `machine_builder_with_vision_ai_need`
- `industrial_camera_vendor_without_ai_software`
- `irrelevant`
- `other`

Fuer jedes Filter-Set werden zwei zentrale Kennzahlen berechnet:

- `relevantCount`
- `relevanceRatio`

Beispielhafte Entscheidungslogik:

- ab 60 Prozent relevant: skalieren und Nachbarfilter testen
- 35 bis 59 Prozent relevant: enger schneiden und Keywords verfeinern
- unter 35 Prozent relevant: ersetzen

Empfohlene Fruehabbruch-Logik:

- nach 10 geprueften Firmen abbrechen, wenn weniger als 35 Prozent relevant sind
- bei sehr teuren Research-Setups auf 5 Firmen fuer den ersten Cut gehen
- bei breiten, verrauschten Maerkten eher 15 Firmen als Startprobe nehmen

## 4. Loopback zu Apollo

Der wichtigste Punkt im System ist das Lernen aus den Samples.

Beispiele fuer Loopback-Regeln:

1. Viele relevante AI-Integratoren, aber wenig industrielle Use Cases: Keywords um `factory`, `inspection`, `production`, `automation` erweitern.
2. Viele Maschinenbauer, aber geringe Vision-AI-Passung: staerker auf `quality control`, `inspection`, `vision system`, `inline` filtern.
3. Viele irrelevante Firmen: Geographie, Mitarbeitergroesse oder Industrie-Tag enger setzen.
4. Wenn ein Filter frueh abgebrochen wurde: nicht auf denselben Filter weiterlaufen, sondern nur die schwache Dimension mutieren, also z. B. Keyword-Set oder Region statt alles gleichzeitig.

Der Code bildet diese Stelle heute strukturell ab. Der naechste reale Ausbauschritt ist eine automatische Filter-Mutation aus Evaluation plus LLM-Ausgabe.

## 5. Deep Research Agent

Nur die besten Firmen gehen in die tiefe Recherche.

Pro Firma werden erzeugt:

- Overview
- Qualification summary
- LinkedIn angle
- Email angle
- Phone angle
- Event or trade-show hypothesis

Fuer echtes Online Research braucht ihr zusaetzlich zu Azure OpenAI entweder:

1. einen Web-Search-faehigen Azure-Pfad
2. einen separaten Search Provider
3. oder einen Browser/Research-Agent mit kontrollierter Tool-Nutzung

## 6. HubSpot Sync Agent

Die final qualifizierten Firmen werden in HubSpot geschrieben.

Empfohlene Datenpunkte in HubSpot:

- Company name
- domain
- country
- lead category
- lead relevance score
- lead rationale
- outreach linkedin angle
- outreach email angle
- outreach phone angle
- outreach event idea

Wenn ihr mehr Governance wollt, lohnt sich ein eigenes Custom Object wie `research_lead` oder `lead_batch_run`.

## 7. Operating Model

Empfohlener Start fuer den Live-Betrieb:

1. `dryRun=true` mit echten Keys testen.
2. Apollo live schalten, HubSpot aber noch im Dry-Run lassen.
3. Research live schalten und Resultate manuell gegenpruefen.
4. HubSpot Writeback erst danach live nehmen.

So trennt ihr Datenqualitaet, Researchqualitaet und CRM-Schreibvorgaenge sauber voneinander.

## 8. Weitere Effizienzhebel

1. Deep Research nur fuer die Top-N Firmen je Filter, nicht fuer jede relevante Firma.
2. Identische Domains und Firmen vor der Research-Phase deduplizieren.
3. Filter mit sehr hoher Relevanzquote zuerst skalieren und schwache Filter spaeter oder gar nicht pruefen.
4. Research-Briefs cachen, damit dieselbe Firma bei spaeteren Runs nicht neu analysiert wird.
5. HubSpot nur nach finaler Qualifikation beschreiben, nicht schon nach der Vorprobe.
6. Eine Negativliste fuer irrelevante Branchen wie VC, Banken, PE, Recruiting und reine Beratung pflegen.