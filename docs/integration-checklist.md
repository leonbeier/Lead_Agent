# Integration Checklist

## Apollo

- API key eintragen in `.env`
- pruefen, welche exakten Apollo Search-Endpunkte im Account freigeschaltet sind
- Feldmapping fuer Industry, Keywords, Geography und Employee Range gegen echte Response-Struktur testen

## Azure OpenAI

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT`
- pruefen, ob strukturierte JSON-Antworten im gewaehlten Deployment stabil laufen
- optionalen Research-Pfad fuer echtes Web Research definieren

## HubSpot

- private app token hinterlegen
- Custom Properties anlegen fuer:
  - `lead_category`
  - `lead_relevance_score`
  - `lead_rationale`
  - `outreach_linkedin_angle`
  - `outreach_email_angle`
  - `outreach_phone_angle`
  - `outreach_event_idea`
- entscheiden, ob auf `companies` geschrieben wird oder auf ein eigenes Custom Object

## Security

- Backend mit Auth absichern, bevor HubSpot live darauf schreibt
- Requests aus HubSpot signieren oder ueber allowlisted infrastructure routen
- Rate limits pro Anbieter pruefen

## Go-Live Reihenfolge

1. Dry-Run Endpunkte lokal testen
2. Apollo live testen
3. Azure Kategorisierung live testen
4. Deep Research live testen
5. HubSpot Sync live testen