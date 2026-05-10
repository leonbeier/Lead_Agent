# Prompting Guide

## Ziel

Der Agent soll nicht generisch nach "AI companies" suchen, sondern strikt entlang des ONE-WARE-ICP arbeiten.

## Was jetzt im Code verankert ist

- Fokus auf Software-Integratoren, industrielle Endkunden mit QC- oder Automationsbedarf und Hardware-/Maschinenpartner ohne starken eigenen Vision-AI-Software-Stack
- aktive Abwertung fuer VC, Banken, PE, generische Beratungen und klare Wettbewerber mit eigenem dominanten Vision-AI-Software-Angebot
- starke Priorisierung von Deutschland und danach Europa, USA, Japan und Korea
- Outreach basiert auf festen Segment-Templates und wird nur bei klaren Anknuepfungspunkten personalisiert

## Relevante Datei

Die zentrale Steuerung liegt in `src/prompting/one-ware-playbook.ts`.

Dort liegen:

- ICP- und Disqualifier-Regeln
- Messaging-Prinzipien
- Outreach-Templates fuer Software-Integratoren, Industrie-Kunden und Hardware-Partner

## Warum das wichtig ist

Der bisherige Failure-Mode war:

1. zu breite Lead-Auswahl
2. zu viele volle Analysen fuer schwache Kandidaten
3. zu stark frei formulierte Outreach-Mails ohne klaren ONE-WARE-USP

Die neue Logik zieht genau dort enger.

## Naechster sinnvoller Ausbau

1. Template-Versionen in HubSpot als editierbare Quelle spiegeln
2. Filter-Mutation aus schlechten Apollo-Samples automatisch aus dem Prompt ableiten
3. harte Negativlisten und Keyword-Blacklists vor die KI-Stufe ziehen