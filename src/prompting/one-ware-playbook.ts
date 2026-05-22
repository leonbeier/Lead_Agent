import {
  EditableExecutionContext,
  EditablePrequalificationCategoryContext,
  LeadCategory,
  PrequalificationConfig,
  SelectableLeadCategory
} from "../types";

export interface OutreachTemplate {
  key: string;
  audience: string;
  goal: string;
  subject: string;
  emailBody: string;
  linkedInConnectionRequest: string;
  linkedInMessage: string;
  phoneScript: string;
}

export interface CategoryExecutionContext {
  category: LeadCategory;
  label: string;
  researchPriorities: string[];
  outreachPriorities: string[];
  personalizationRules: string[];
  avoidSignals: string[];
}

export interface CategoryPrequalificationContext {
  category: LeadCategory;
  label: string;
  classificationRules: string[];
  disqualifiers: string[];
}

export const TARGET_REGIONS = [
  "Germany",
  "Austria",
  "Switzerland",
  "Benelux",
  "Netherlands",
  "Belgium",
  "Luxembourg",
  "Nordics",
  "Denmark",
  "Sweden",
  "Norway",
  "Finland",
  "United States",
  "Japan",
  "South Korea"
];

export const NON_TARGET_SIGNALS = [
  "magazine",
  "publisher",
  "media",
  "news portal",
  "editorial",
  "event",
  "association",
  "university",
  "research institute",
  "venture capital",
  "private equity",
  "investor",
  "bank",
  "insurance",
  "financial services",
  "generic consultancy",
  "reseller",
  "robot manufacturer",
  "robotics vendor",
  "oem product vendor",
  "china",
  "saudi arabia"
];

export const ONE_WARE_PROMPT_CONTEXT = `
You represent ONE WARE GmbH.

ONE WARE provides software that turns customer data into production-ready Physical AI, Vision AI, and Edge AI models in minutes instead of long manual iteration cycles.

Core value:
- Reduce trial and error in model development.
- Shorten time to production.
- Make delivery timelines more predictable.
- Enable smaller and more hardware-efficient models.
- Lower engineering effort and deployment friction.
- Support local training and vendor-independent deployment.

When evaluating or writing about companies, anchor on concrete business problems ONE WARE can solve rather than generic AI excitement.
`;

export const DEFAULT_MAIN_CONTEXT = ONE_WARE_PROMPT_CONTEXT.trim();

export const DEFAULT_SEARCH_STRATEGY_CONTEXT =
  "Prioritize firms where public evidence suggests real delivery ownership, industrial deployment relevance, recurring implementation work, or a credible partner/embed path for ONE WARE. Start by identifying the firm archetype objectively before assuming fit. Generalize from concrete business-model evidence instead of from company-name examples. The most productive search clusters so far are Germany Machine Vision System Integrators, Germany Industrial Computer Vision Engineering Services, Germany Automation Software Integrators, and Germany Smart Factory Software Engineering Partners, so prefer those angles before widening. A probe is already acceptable when at least 15% of reviewed companies are relevant; below that, tighten the search terms and source types instead of broadening. Prefer service-led search terms such as project-based software integrator, system integrator, implementation, engineering services, automation software, embedded development, inspection integration, and industrial software projects. Keep the strongest signal keywords concrete: machine vision, industrial inspection, image processing, inline inspection, optical quality control, MES integration, SCADA integration, PLC software integration, OT integration, smart factory software, and industrial software engineering in Germany. Treat exclusions as equally important as positive terms: explicitly avoid hardware vendors, OEMs, publishers, media brands, pure consultancies, directory-like lists, marketplaces, and broad global aggregator pages. Default to internet research using official company sites, trade fair exhibitor lists, expo catalogs, partner pages, technical magazine coverage, and customer case studies to discover firms, then return only the official company websites. Avoid broadeners like AI solutions, manufacturing on its own, generic AI, broad software terms, or employee-range widening when they are likely to pull generic AI vendors, software companies, hardware brands, or other weak-fit profiles. Search broadly enough to discover strong-fit companies, then filter conservatively based on concrete signals rather than generic AI claims. Use Apollo only as a fallback when public contact details are missing for otherwise qualified companies.";

export const DEFAULT_PREQUALIFICATION_MAIN_CONTEXT =
  "Decide relevance conservatively and completely unbiased. First identify the company archetype: implementation-led integrator, industrial end customer, camera/imaging manufacturer, machine builder/OEM, software platform, or clearly irrelevant profile such as media, publisher, event, association, university, research institute, VC, investor, bank, insurer, recruiter, reseller, or generic consultancy. Use the full company website evidence, not just homepage wording: about, products, services, integrations, documentation, applications, references, and industry pages can all contain the decisive business-model signal. A company is relevant only when there is evidence for real delivery ownership, industrial applicability, or a credible ONE WARE partner path. Reject weak-fit finance, recruiting, HR, generic non-industrial SaaS, vague consulting profiles without implementation responsibility, and product-led robotics or hardware brands when no delivery ownership is visible.";

export const DEFAULT_PREQUALIFICATION_CATEGORY_CONTEXTS: Record<SelectableLeadCategory, EditablePrequalificationCategoryContext> = {
  integrator_vision_industrial_ai: {
    addOnContext:
      "Require explicit evidence for Vision AI, machine vision, industrial inspection, edge AI deployment, or comparable delivery work. Relevance is strongest when the company implements custom projects for customers instead of just reselling products. Do not use this category for robot makers, OEMs, or hardware brands unless customer implementation services are clearly part of the business."
  },
  integrator_vision_ai_consulting: {
    addOnContext:
      "Treat as relevant when a consulting firm or boutique explicitly delivers machine vision, industrial AI, AOI, embedded vision, or inspection implementation work for customers. Exclude generic strategy consulting, training-only offers, vague AI advisory without hands-on delivery, and solo freelancer profiles."
  },
  integrator_vision_ai_freelancer: {
    addOnContext:
      "Treat as relevant when an individual freelancer, solo consultant, or very small independent specialist explicitly delivers machine vision, industrial AI, AOI, embedded vision, or inspection implementation work for customers. Exclude generic AI advisory, staffing-style contractor pools, and training-only offers."
  },
  integrator_general_ai: {
    addOnContext:
      "Treat as relevant when the company clearly delivers customer-specific software, AI, automation, MES/SCADA, or digital-engineering projects and there is a plausible path into Vision AI or industrial deployment. Generic AI branding alone is not enough. Generic software or engineering agencies without explicit industrial, automation, instrumentation, data, or implementation-heavy signals should stay other. Broad product-development firms with hardware, firmware, and system-engineering menus but no clear software or automation delivery should also stay other. Internal IT organizations can still fit when they repeatedly build and integrate MES, EDI, BI, process, or enterprise software systems for a larger industrial group. Niche municipal cloud products with onboarding or rollout help for their own workflow should still stay other."
  },
  integrator_relevant_focus: {
    addOnContext:
      "Require both project-delivery ownership and a relevant vertical such as surveillance, medtech vision, agriculture tech, defence, automotive, industrial automation, semiconductors, embedded systems, measurement automation, or industrial electronics. The vertical should make camera-, inspection-, control-, compute-, or edge-AI use cases plausible. This bucket can include specialist delivery firms in ASIC/FPGA/SoC, embedded, industrial-computing, or instrumentation domains when they build customer-specific technical solutions or integrated systems for clients. Suppliers of embedded-computing platforms, rugged systems, or industrial electronics can also fit when custom solutions and system-integration services are central, not merely catalog hardware sales. Do not use the category only because the company sells robots, drone products, generic engineering capacity, or catalog hardware into one of these verticals. If evidence is mixed between catalog hardware and custom industrial system delivery, prefer this category or other over irrelevant."
  },
  industrial_end_customer_scaled: {
    addOnContext:
      "Treat as relevant only when the company has its own production, operational scale, and a believable quality-control, inspection, or process-automation need. Look for factories, plants, manufacturing lines, engineering teams, or industrial operations."
  },
  camera_manufacturer_partner: {
    addOnContext:
      "Treat as relevant when the company manufactures cameras, imaging modules, or machine-vision hardware and could benefit from offering AI-ready solutions to customers. Exclude firms whose core monetization is already their own competing vision software stack."
  },
  machine_builder_ai_enablement: {
    addOnContext:
      "Treat as relevant when the company builds machines, OEM systems, production equipment, industrial fixtures, hardware-centric inspection products, scanners, scan bars, imaging appliances, appliance-like products, or a single-purpose productized Vision-AI or radiology-AI application that could be improved as a shipped product. Medical-imaging or radiology AI plugins that are inserted into existing PACS/RIS or diagnostic workflows can still fit here when the monetization is the shipped application itself. If the main fit is that ONE WARE would be embedded into the company's own shipped software product, prefer this category over integrator buckets. Do not use this category for broad workflow platforms, marketplaces, or orchestration layers unless the software is mainly bundled with a shipped machine, appliance, or physical OEM product."
  },
  software_platform_embedding: {
    addOnContext:
      "Treat as relevant when the company operates a software platform, installable product, plugin-style product, marketplace, measurement-automation layer, workflow product, test-and-measurement suite, driver/module ecosystem, or clinical/industrial software environment with a credible integration surface where ONE WARE could be embedded as a model-generation backend. Product documentation, app management, install/get-started flows, app stores, module catalogs, driver libraries, and integration guides are strong evidence for this category. A platform vendor does not become an integrator only because it helps customers deploy, connect, or roll out its own product. If customers can build, configure, train, distribute, or run their own apps, AI workflows, models, or extensions on top of the platform, prefer this category. Platforms with app studios, app stores, dashboard builders, modules, or device/app management should usually stay here even when OEM rollout or enablement services are also mentioned. The product does not need to offer AI today; a modular software environment with a credible place to embed ONE WARE is enough. Require an actual product surface such as APIs, plugins, drivers, extensions, workflow modules, scriptable automation, device connectors, or configurable integrations, not a services-only company. Municipal or route-planning platforms without a clear model/embed path should stay other."
  }
};

export const OUTREACH_TEMPLATES: Record<string, OutreachTemplate> = {
  integrator_vision_industrial_ai_template: {
    key: "integrator_vision_industrial_ai_template",
    audience: "Software/automation integrators with clear Vision AI or Industrial AI delivery focus",
    goal: "Position ONE WARE as a delivery multiplier for recurring industrial Vision AI projects.",
    subject: "Vision-AI ohne lange Optimierungsphasen",
    emailBody:
      "Hallo [Name],\n\nich habe gesehen, dass Sie Vision-AI-nahe Integrationsprojekte umsetzen. Haben Sie in dem Bereich bereits die Erfahrung gemacht, dass kleine Datensätze, viel Ausprobieren und schwankende Modellqualität Projekte unnötig ausbremsen?\n\nGenau dort setzen wir mit ONE WARE an. Unsere Software erstellt aufgabenspezifische Vision-AI-Modelle mit deutlich weniger manuellem Ausprobieren, oft schon mit kleineren Datensätzen und in vielen Fällen genauer als universelle Modelle. Gleichzeitig lassen sich die Ergebnisse auf günstiger Hardware produktionsnah einsetzen.\n\nWir haben bereits Unternehmen gesehen, die dadurch nicht nur einen einzelnen Use Case, sondern direkt mehrere Prüf- und Automatisierungsschritte angehen wollten. Für Integratoren ist das besonders interessant, weil Projekte schneller lieferbar werden und wir bei passenden Fällen auch Firmenkunden vermitteln können.\n\nWäre ein kurzer Austausch sinnvoll, ob das für Ihre aktuellen Projekte relevant ist?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInConnectionRequest:
      "Kurze Frage: Setzen Sie bereits Vision-AI-Projekte um? Wir sehen oft, dass mit kleineren Datensätzen und weniger Ausprobieren schneller gute Ergebnisse möglich sind.",
    linkedInMessage:
      "Kurze Frage: Setzen Sie bereits Vision-AI-Projekte um? Wir sehen oft, dass mit kleineren Datensätzen und deutlich weniger Ausprobieren schneller genauere Modelle entstehen können als mit universellen Ansätzen. Wäre das für Sie interessant?",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie aktuell Vision-AI-Anwendungen bei Kunden umsetzen oder dort bereits Erfahrung haben. Falls ja: Wir haben eine Software, mit der deutlich schneller produktionsreife Vision-AI-Modelle erstellt werden können. Weil wir nicht jeden Integrations- und Beratungsanteil selbst abdecken können, sprechen wir mit Partnern, für die eine Zusammenarbeit sinnvoll sein könnte. Wäre das grundsätzlich interessant für Sie?"
  },
  integrator_vision_ai_consulting_template: {
    key: "integrator_vision_ai_consulting_template",
    audience: "Vision AI / Industrial AI consulting firms and specialist boutiques with hands-on delivery ownership",
    goal: "Position ONE WARE as a force multiplier for consulting teams delivering industrial vision and inspection projects.",
    subject: "Vision-AI-Beratungsprojekte schneller und planbarer liefern",
    emailBody:
      "Hallo [Name],\n\nwenn Sie Kunden zu Vision AI beraten oder Projekte begleiten, kennen Sie vermutlich die Situation: Die Idee ist gut, aber Modellwahl, Datenqualität und Iterationen kosten deutlich mehr Zeit als gedacht.\n\nWir haben dafür mit ONE WARE ein neues Verfahren, das aus vorhandenen Daten sehr schnell produktionsreife Vision-AI-Modelle erzeugen kann. Dadurch lassen sich Kundenprojekten oft schneller belastbare Ergebnisse zeigen, auch wenn der Datensatz nicht perfekt ist.\n\nWir haben bereits gute Erfahrungen mit Unternehmen gemacht, die danach direkt mehrere Bereiche wie Qualitätskontrolle oder Prozessschritte automatisieren wollten. Für Beratungen ist das interessant, weil es ein starkes Verfahren ist, das man Kunden empfehlen kann, und wir bei passenden Fällen auch Firmenkunden vermitteln können.\n\nWäre ein kurzer Austausch sinnvoll, ob das zu Ihren Kundenprojekten passt?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInConnectionRequest:
      "Kurze Frage: Beraten Sie Kunden bereits zu Vision AI? Wir haben ein neues Verfahren, mit dem deutlich schneller belastbare Modelle entstehen können.",
    linkedInMessage:
      "Kurze Frage: Beraten Sie Kunden bereits zu Vision AI? Wir haben ein Verfahren, mit dem deutlich schneller belastbare Modelle entstehen und das sich gut als neuer Lösungsbaustein für Kundenprojekte eignet.",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie Vision-AI-Anwendungen aktuell für Kunden umsetzen oder in dem Bereich Erfahrung haben. Wir haben eine Software, mit der sich produktionsreife Vision-AI-Modelle deutlich schneller erstellen lassen. Da uns für die komplette Integrations- und Beratungsleistung nicht überall die Kapazität reicht, suchen wir gezielt nach Partnern für gemeinsame Projekte. Wäre so eine Zusammenarbeit für Sie grundsätzlich interessant?"
  },
  integrator_vision_ai_freelancer_template: {
    key: "integrator_vision_ai_freelancer_template",
    audience: "Independent Vision AI / Industrial AI freelancers and solo specialists with hands-on delivery ownership",
    goal: "Position ONE WARE as leverage for solo experts who need to deliver more with limited hands-on engineering time.",
    subject: "Vision-AI-Freelance-Projekte mit weniger Tuning-Aufwand liefern",
    emailBody:
      "Hallo [Name],\n\nwenn Sie Vision-AI-Projekte eigenständig umsetzen, kennen Sie sicher den Aufwand mit Datensätzen, Modellwahl und vielen Schleifen, bis ein Ergebnis wirklich stabil ist.\n\nMit ONE WARE lassen sich aufgabenspezifische Vision-AI-Modelle deutlich schneller erzeugen, oft schon mit kleineren Datensätzen und mit weniger manuellem Ausprobieren. In vielen Fällen ist die Genauigkeit dabei besser als bei universellen Modellen, und die Lösung kann auf günstiger Hardware laufen.\n\nDas ist gerade für Freelancer interessant, weil sich Projekte dadurch schneller liefern lassen. Und wenn es passt, können wir auch Firmenkunden oder Teilprojekte vermitteln.\n\nWäre ein kurzer Austausch sinnvoll, ob das für Ihre aktuellen Projekte spannend ist?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInConnectionRequest:
      "Kurze Frage: Setzen Sie bereits Vision-AI-Projekte um? Mit kleineren Datensätzen und weniger Ausprobieren lassen sich oft schneller gute Ergebnisse erreichen.",
    linkedInMessage:
      "Kurze Frage: Setzen Sie bereits Vision-AI-Projekte um? Wir sehen oft, dass mit kleineren Datensätzen und weniger manuellem Ausprobieren schneller sehr gute Ergebnisse entstehen können. Wäre das für Sie interessant?",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie Vision-AI-Anwendungen aktuell für Kunden umsetzen oder in dem Bereich Erfahrung haben. Wir haben eine Software, mit der deutlich schneller produktionsreife Vision-AI-Modelle erstellt werden können. Weil wir nicht jede Integrations- und Beratungsleistung selbst begleiten können, prüfen wir aktuell auch Partnerschaften mit erfahrenen Spezialisten. Wäre das für Sie grundsätzlich spannend?"
  },
  integrator_general_ai_template: {
    key: "integrator_general_ai_template",
    audience: "Software/automation integrators with general AI focus and delivery ownership",
    goal: "Pivot from generic AI messaging to concrete Vision AI delivery throughput and margin gains.",
    subject: "AI-Projekte schneller zu produktionsreifer Vision-AI machen",
    emailBody:
      "Hallo [Name],\n\nich habe gesehen, dass Sie Software- und AI-Projekte umsetzen. Mich würde interessieren, ob Sie dabei auch schon praktische Erfahrung mit Vision AI gesammelt haben.\n\nFalls ja, könnte ONE WARE für Sie interessant sein. Unsere Software erzeugt Vision-AI-Modelle deutlich effizienter, mit weniger manuellem Ausprobieren und deutlich geringerem Aufwand bis zur produktionsreifen Lösung.\n\nFür Integratoren und Dienstleister ist das spannend, weil Projekte schneller lieferbar werden. Zusätzlich haben wir Firmenkunden mit konkreten Use Cases, bei denen wir passende Partner für die Umsetzung einbinden können.\n\nWäre ein kurzer Austausch sinnvoll, ob das für Sie relevant sein könnte?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInConnectionRequest:
      "Kurze Frage: Haben Sie bei Ihren Software- oder AI-Projekten auch schon Vision-AI-Erfahrung gesammelt? Falls ja, könnte ONE WARE relevant für Sie sein.",
    linkedInMessage:
      "Kurze Frage: Haben Sie bei Ihren Software- oder AI-Projekten auch schon Vision-AI-Erfahrung gesammelt? Falls ja, könnten wir für schnellere und effizientere Vision-AI-Umsetzung interessant sein.",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie bereits Vision-AI-Anwendungen für Kunden umsetzen oder das aktuell aufbauen. Wir haben eine Software, mit der Vision-AI-Modelle deutlich schneller produktionsreif werden. Da wir nicht alle Integrations- und Beratungsprojekte selbst stemmen können, suchen wir Gespräche mit Dienstleistern, bei denen eine Zusammenarbeit sinnvoll sein könnte. Wäre das für Sie ein Thema?"
  },
  integrator_relevant_focus_template: {
    key: "integrator_relevant_focus_template",
    audience: "Software/automation integrators with relevant vertical focus (defence, surveillance, robotics, medtech vision, agriculture, automotive)",
    goal: "Connect ONE WARE to vertical delivery bottlenecks in vision-heavy customer projects.",
    subject: "Vision-AI in projektnahen Verticals schneller und planbarer liefern",
    emailBody:
      "Hallo [Name],\n\nhaben Sie da auch schon Erfahrung gemacht, Vision AI zum Beispiel für Qualitätskontrolle einzubauen?\n\nGenau dort kann ONE WARE relevant sein. Mit unserer Software lassen sich aufgabenspezifische Vision-AI-Modelle deutlich schneller erzeugen, mit weniger manuellem Ausprobieren und oft auch so, dass kleinere oder günstigere Hardware-Setups realistisch werden.\n\nFür Integratoren ist das besonders interessant, weil Projekte planbarer werden und sich mehr davon in der gleichen Zeit umsetzen lassen. Wenn es passt, können wir auch über konkrete Kundenprojekte oder eine Zusammenarbeit sprechen.\n\nWäre ein kurzer Austausch sinnvoll, ob das zu Ihren Projekten passt?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInConnectionRequest:
      "Kurze Frage: Haben Sie schon Erfahrung damit, Vision AI zum Beispiel für Qualitätskontrolle einzubauen?",
    linkedInMessage:
      "Kurze Frage: Haben Sie schon Erfahrung damit, Vision AI zum Beispiel für Qualitätskontrolle einzubauen? Genau dort hilft ONE WARE, Modelle schneller und mit weniger manuellem Ausprobieren produktionsreif zu bekommen.",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie schon Erfahrung damit gemacht haben, Vision AI zum Beispiel für Qualitätskontrolle in Projekte einzubauen. Genau dort helfen wir mit einer Software, mit der sich Vision-AI-Modelle deutlich schneller produktionsreif erstellen lassen. Weil wir nicht alle Integrationsprojekte selbst begleiten können, sprechen wir auch mit spezialisierten Partnern über mögliche Zusammenarbeit. Wäre das für Ihr Team grundsätzlich interessant?"
  },
  industrial_end_customer_scaled_template: {
    key: "industrial_end_customer_scaled_template",
    audience: "Industrial end customers with own production and sufficient scale for high-value QC/process-automation projects",
    goal: "Position ONE WARE as a fast and economical path to production-ready Vision AI for scaled operations.",
    subject: "Qualitätskontrolle und Vision-AI wirtschaftlicher umsetzen",
    emailBody:
      "Hallo [Name],\n\nbei Themen wie Qualitätskontrolle sehen wir häufig, dass Vision AI zwar sehr sinnvoll wäre, die Umsetzung über externe Dienstleister aber zu teuer oder zu aufwendig wird.\n\nMit ONE WARE lassen sich aufgabenspezifische Modelle deutlich schneller erstellen und auf günstiger Hardware einsetzen. Dadurch konnten Projekte mit weniger Aufwand und niedrigeren Hardwarekosten umgesetzt werden als in klassischen Setups.\n\nGerade für Industrieunternehmen ist das interessant, weil unsere KI-Lizenz in vielen Fällen deutlich günstiger ist, als eine komplette individuelle Entwicklung dauerhaft extern einzukaufen.\n\nWenn Sie möchten, prüfen wir gern, ob ein konkreter Qualitätskontroll- oder Automatisierungsfall bei Ihnen dafür geeignet ist.\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInConnectionRequest:
      "Kurze Frage: Gibt es bei Ihnen Qualitätskontroll- oder Prozessautomations-Themen, bei denen Vision AI sinnvoll wäre, bisher aber zu aufwendig war?",
    linkedInMessage:
      "Kurze Frage: Gibt es bei Ihnen Qualitätskontroll- oder Prozessautomations-Themen, bei denen Vision AI sinnvoll wäre, bisher aber zu teuer oder zu aufwendig war? Genau dort setzen wir an.",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Themen wie Qualitätskontrolle oder Prozessautomation bei Ihnen aktuell relevant sind. Wir haben die Erfahrung gemacht, dass sich Vision AI dafür oft mit deutlich weniger Aufwand und auf günstigerer Hardware umsetzen lässt, als viele erwarten. Wäre das bei Ihnen grundsätzlich interessant?"
  },
  camera_manufacturer_partner_template: {
    key: "camera_manufacturer_partner_template",
    audience: "Camera or imaging manufacturers that can offer AI-ready customer setups",
    goal: "Position ONE WARE as the software layer to enable AI-capable camera deployments for customers.",
    subject: "Vision-AI einfacher in Kamera- und Imaging-Lösungen integrieren",
    emailBody:
      "Hallo [Name],\n\nbei Kamera- und Imaging-Lösungen gibt es immer wieder Kunden, bei denen Standardmodelle für den konkreten Use Case nicht ausreichen oder der vorhandene Datensatz zu schwierig ist. Genau dann dauern Modellwahl und Optimierung oft viel zu lange.\n\nMit ONE WARE können Sie Ihren Kunden eine zusätzliche Option geben, mit der deutlich schneller das passende Vision-AI-Modell entsteht. Das ist besonders interessant, wenn Kunden spezielle Anforderungen haben und nicht mit einem Standardansatz weiterkommen.\n\nSo bekommen Ihre Kunden schneller ein belastbares Ergebnis und Sie können Vision AI leichter als Teil Ihrer Lösung anbieten.\n\nWäre ein kurzer Austausch interessant, ob das für Ihre Kunden sinnvoll sein könnte?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInConnectionRequest:
      "Kurze Frage: Haben Sie Kunden, bei denen Standardmodelle für den Vision-Use-Case nicht ausreichen oder der Datensatz schwierig ist? Genau dort kann ONE WARE helfen.",
    linkedInMessage:
      "Kurze Frage: Haben Sie auch Kunden, bei denen Standardmodelle für den konkreten Vision-Use-Case nicht ausreichen oder der Datensatz schwierig ist? Genau dafür kann ONE WARE interessant sein.",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie auch Kundenfälle haben, bei denen Standardmodelle für den konkreten Vision-Use-Case nicht ausreichen oder der Datensatz schwierig ist. Genau dafür haben wir mit ONE WARE eine zusätzliche Option, mit der Kunden schneller zum passenden Modell kommen. Wäre das für Sie interessant?"
  },
  machine_builder_ai_enablement_template: {
    key: "machine_builder_ai_enablement_template",
    audience: "Machine builders, hardware vendors, or product teams with their own Vision-AI application",
    goal: "Position ONE WARE as an AI enablement layer for product teams shipping Vision AI without long model-development cycles.",
    subject: "Vision-AI einfacher in Maschinen und Produkte integrieren",
    emailBody:
      "Hallo [Name],\n\nbei Maschinenbau- und Produktprojekten gibt es oft Kundenfälle, in denen ein Standardmodell nicht sauber funktioniert oder der vorhandene Datensatz zu klein und zu speziell ist. Genau dann zieht sich der Weg zum guten Vision-AI-Modell oft unnötig in die Länge.\n\nMit ONE WARE können Sie eine zusätzliche Option integrieren, mit der für den konkreten Use Case schneller das beste Modell gefunden wird. Das hilft besonders dann, wenn Kunden eine individuelle Lösung brauchen und mit Standardansätzen nicht weiterkommen.\n\nSo lässt sich Vision AI einfacher als belastbare Produktfunktion oder Kundenoption anbieten.\n\nWäre ein kurzer Austausch interessant, ob das bei Ihnen produktseitig sinnvoll sein könnte?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInConnectionRequest:
      "Kurze Frage: Haben Sie Kundenfälle, bei denen Standardmodelle für den Vision-Use-Case nicht ausreichen oder der Datensatz schwierig ist?",
    linkedInMessage:
      "Kurze Frage: Haben Sie Kundenfälle, bei denen Standardmodelle für den konkreten Vision-Use-Case nicht ausreichen oder der Datensatz schwierig ist? Genau dort kann ONE WARE helfen.",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie Kundenprojekte haben, bei denen Standardmodelle für den konkreten Vision-Use-Case nicht ausreichen oder der Datensatz schwierig ist. Mit ONE WARE kann man für solche Fälle schneller das passende Modell finden und als zusätzliche Option in Produkte oder Maschinen integrieren. Wäre das bei Ihnen ein Thema?"
  },
  software_platform_embedding_template: {
    key: "software_platform_embedding_template",
    audience: "Software platforms that can embed ONE WARE as model-generation alternative (e.g. Roboflow-like)",
    goal: "Position ONE WARE as embeddable model-generation backend for platform providers.",
    subject: "Embeddable Vision-AI Modell-Engine für Ihre Plattform",
    emailBody:
      "Hallo [Name],\n\nwenn Nutzer einer Plattform mit Vision AI arbeiten, gibt es fast immer Fälle, in denen Standardmodelle nicht gut genug sind oder der Datensatz schwierig ist. Dann wird genau die Modellerstellung schnell zum Engpass.\n\nONE WARE kann hier als zusätzliche Option eingebettet werden, damit für den jeweiligen Use Case schneller das beste Modell entsteht. Das ist besonders wertvoll für Plattformen, die ihren Kunden nicht nur Standardmodelle, sondern den schnellsten Weg zu einem wirklich passenden Ergebnis bieten wollen.\n\nWäre ein kurzer technischer Austausch sinnvoll, ob das als Erweiterung für Ihre Plattform interessant ist?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInConnectionRequest:
      "Kurze Frage: Haben Ihre Nutzer Fälle, in denen Standardmodelle nicht ausreichen oder der Datensatz schwierig ist? Dafür kann ONE WARE interessant sein.",
    linkedInMessage:
      "Kurze Frage: Haben Ihre Nutzer auch Fälle, in denen Standardmodelle nicht ausreichen oder der Datensatz schwierig ist? Dafür kann ONE WARE als zusätzliche Modelloption interessant sein.",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Ihre Nutzer auch Fälle haben, in denen Standardmodelle nicht ausreichen oder der Datensatz schwierig ist. Genau dort kann ONE WARE als zusätzliche Modelloption interessant sein, damit Nutzer schneller zum besten Ergebnis kommen. Wäre das für Ihre Plattform relevant?"
  }
};

export const CATEGORY_PREQUALIFICATION_CONTEXT: Record<LeadCategory, CategoryPrequalificationContext> = {
  integrator_vision_industrial_ai: {
    category: "integrator_vision_industrial_ai",
    label: "Integrators with explicit Vision/Industrial AI focus",
    classificationRules: [
      "Relevant when the website explicitly mentions Vision AI, machine vision, industrial AI delivery, inspection AI, computer vision integration, or edge-vision deployment.",
      "Delivery ownership should be visible through implementation services, custom projects, deployment language, system integration, or customer solution references.",
      "Signals like integrator, solution provider, automation partner, inspection projects, or hardware/software deployment strengthen relevance."
    ],
    disqualifiers: ["Pure product vendor without implementation ownership", "Direct competing own vision platform as the primary business", "Generic AI marketing with no real delivery proof"]
  },
  integrator_vision_ai_consulting: {
    category: "integrator_vision_ai_consulting",
    label: "Vision AI / Industrial AI consulting firms",
    classificationRules: [
      "Relevant when a consulting firm or specialist boutique explicitly delivers machine vision, industrial AI, AOI, embedded vision, or inspection implementation work for customers.",
      "Hands-on delivery ownership should be visible through project execution, implementation services, feasibility studies, prototyping, deployment, or retained engineering support.",
      "Use this bucket when the profile is services-led and consulting-shaped, but still clearly commercial and implementation-capable."
    ],
    disqualifiers: ["Solo freelancer profile", "Generic AI advisory without hands-on implementation", "Training-only or workshop-only offers", "Management or strategy consulting without technical delivery ownership"]
  },
  integrator_vision_ai_freelancer: {
    category: "integrator_vision_ai_freelancer",
    label: "Vision AI / Industrial AI freelancers",
    classificationRules: [
      "Relevant when an individual freelancer or solo specialist explicitly delivers machine vision, industrial AI, AOI, embedded vision, or inspection implementation work for customers.",
      "Hands-on delivery ownership should be visible through project execution, prototyping, implementation, integration, or retained engineering support.",
      "Use this bucket only when the profile is clearly person-led or solo-expert-led rather than a consulting firm."
    ],
    disqualifiers: ["Consulting firm or agency with a broader team", "Training-only or workshop-only offers", "Generic advisory without hands-on implementation"]
  },
  integrator_general_ai: {
    category: "integrator_general_ai",
    label: "Integrators with general AI focus",
    classificationRules: [
      "Relevant when the company clearly delivers AI projects, customer-specific software implementations, engineering delivery, or automation implementations but is not strongly Vision-AI-specific yet.",
      "There should be evidence for project execution, implementation ownership, or customer-specific delivery rather than advisory-only positioning.",
      "Use this bucket when Vision AI is plausible but not explicit, and the company still looks like a real delivery partner such as a digital-engineering firm or software implementation partner. Do not use it for generic agencies with broad but weakly differentiated service menus, for municipal operations platforms, or for generic hardware/firmware/system-development firms without clear software or automation implementation ownership."
    ],
    disqualifiers: ["AI consulting without implementation", "Generic SaaS AI features without project delivery", "Thought leadership or training-only AI firms"]
  },
  integrator_relevant_focus: {
    category: "integrator_relevant_focus",
    label: "Integrators with relevant vertical focus",
    classificationRules: [
      "Relevant when the company delivers projects in surveillance, defence, medtech vision, robotics, drones, agriculture tech, automotive tech, industrial automation, semiconductors, embedded electronics, or measurement-heavy industrial domains.",
      "The vertical should make camera, inspection, perception, tracking, control, test, instrumentation, compute, or edge-AI use cases plausible from the company description.",
      "Delivery ownership still matters; do not use this bucket for pure component vendors, generic staff-augmentation engineering firms, or research organizations. Specialist ASIC, FPGA, SoC, embedded-compute, industrial-electronics, or instrumentation consultancies can fit here when they build customer-specific technical solutions or integrated systems. If evidence mixes catalog hardware with explicit custom systems and industrial integration work, prefer this bucket or other over irrelevant."
    ],
    disqualifiers: ["No project-delivery signals", "Irrelevant vertical without vision or automation tie-in", "Pure R&D lab with no commercial delivery path"]
  },
  industrial_end_customer_scaled: {
    category: "industrial_end_customer_scaled",
    label: "Scaled industrial end customers",
    classificationRules: [
      "Relevant when the company runs its own manufacturing, production lines, plants, or industrial operations at meaningful scale.",
      "Look for evidence of quality control, inspection, defect detection, process automation, packaging, assembly, or engineering-led operations.",
      "Engineering ownership, factory footprint, multi-site production, or industrial equipment references strengthen relevance. Internal IT or software integration units supporting a larger industrial group should usually not be placed here unless they directly operate the production environment itself."
    ],
    disqualifiers: ["Small workshop without engineering capacity", "No own production context", "Distributor or trader with no industrial operations"]
  },
  camera_manufacturer_partner: {
    category: "camera_manufacturer_partner",
    label: "Camera manufacturers as partners",
    classificationRules: [
      "Relevant when the company manufactures cameras, imaging systems, machine-vision components, or related hardware sold into customer solutions.",
      "There should be a credible partner path where ONE WARE could upgrade the hardware offer with AI-ready capabilities.",
      "Choose this bucket only when partner fit is stronger than competition risk."
    ],
    disqualifiers: ["Strong own competing vision software monetization", "Pure reseller without product control", "Imaging distributor with no manufacturer or OEM role"]
  },
  machine_builder_ai_enablement: {
    category: "machine_builder_ai_enablement",
    label: "Machine builders for AI enablement",
    classificationRules: [
      "Relevant when the company builds machines, OEM systems, manufacturing equipment, production cells, industrial fixtures, hardware-centric inspection products, scanners, scan bars, imaging appliances, or a single-purpose productized AI application that could gain from embedded Vision AI.",
      "Look for OEM, Sondermaschinenbau, industrial equipment, packaging, assembly, inspection stations, production-line language, shipped physical systems, scanner families, or branded imaging products.",
      "Relevance is strongest when the company could offer AI as an option, module, retrofit, performance upgrade, or product improvement to customers. Single-purpose clinical or radiology AI products can also fit when the monetization is the shipped application itself rather than a platform layer; do not reject them merely because they operate in healthcare."
    ],
    disqualifiers: ["Pure distributor without machine-building capability", "Component seller with no system integration ownership", "No visible OEM, industrial equipment, or concrete shipped product context", "Broad workflow platform or marketplace with no single shipped product focus"]
  },
  software_platform_embedding: {
    category: "software_platform_embedding",
    label: "Software platforms for embedding",
    classificationRules: [
      "Relevant when the company operates a software platform, workflow product, installable software environment, plugin-style product, measurement automation suite, test-and-measurement software, driver/module ecosystem, or developer-facing environment that could embed model-generation capabilities.",
      "A credible integration path should be visible through APIs, extensions, plugins, drivers, workflow automation, platform modules, scripting surfaces, device connectors, or customer-configurable tooling.",
      "Use this only when there is real product surface for embedding, not just service delivery. If documentation, app management, install/get-started flows, app stores, module catalogs, dashboard builders, app studios, or driver libraries dominate the evidence, prefer this category over integrator_general_ai. Municipal operations software or route-planning products without a clear model/embed path should stay other."
    ],
    disqualifiers: ["No extensibility or integration path", "Direct platform competitor with no partner incentive", "Pure agency or service shop with no platform product"]
  },
  irrelevant: {
    category: "irrelevant",
    label: "Irrelevant",
    classificationRules: ["Use when no plausible ONE WARE fit exists."],
    disqualifiers: ["Non-target geography", "Finance/HR/recruiting/VC profiles", "No delivery or use-case fit"]
  },
  other: {
    category: "other",
    label: "Other / unclear",
    classificationRules: ["Use when evidence is too weak or mixed for a strong category assignment, or when a non-industrial software/product business lacks a credible ONE WARE embedding or delivery path."],
    disqualifiers: ["None - this is an uncertainty bucket"]
  }
};

export const CATEGORY_EXECUTION_CONTEXT: Record<LeadCategory, CategoryExecutionContext> = {
  integrator_vision_industrial_ai: {
    category: "integrator_vision_industrial_ai",
    label: "Vision/Industrial AI integrator",
    researchPriorities: [
      "Validate recurring vision-heavy delivery ownership.",
      "Look for fixed-price pressure and repeatable project patterns."
    ],
    outreachPriorities: [
      "Lead with throughput and margin improvements.",
      "Keep partner framing and project efficiency language."
    ],
    personalizationRules: [
      "Personalize only with concrete delivery hooks.",
      "Retain template backbone and ONE WARE USP wording."
    ],
    avoidSignals: ["Generic AI buzzwords without delivery context"]
  },
  integrator_vision_ai_consulting: {
    category: "integrator_vision_ai_consulting",
    label: "Vision AI consulting firm",
    researchPriorities: [
      "Validate explicit hands-on delivery ownership in customer projects.",
      "Check whether the consulting team would benefit from shorter model iteration cycles and reusable deployment workflows."
    ],
    outreachPriorities: [
      "Lead with leverage for consulting delivery teams and reduced project overhead.",
      "Keep language concrete around client work, prototypes, and production handoff."
    ],
    personalizationRules: [
      "Personalize around visible project types, feasibility work, or implementation bottlenecks.",
      "Avoid enterprise-style language that does not fit a specialist consulting profile."
    ],
    avoidSignals: ["Generic transformation consulting language", "Treating them like a scaled integrator organization"]
  },
  integrator_vision_ai_freelancer: {
    category: "integrator_vision_ai_freelancer",
    label: "Vision AI freelancer",
    researchPriorities: [
      "Validate explicit hands-on delivery ownership in customer projects.",
      "Check whether a solo expert would benefit from shorter model iteration cycles and reusable deployment workflows."
    ],
    outreachPriorities: [
      "Lead with leverage for solo delivery capacity and reduced project overhead.",
      "Keep language concrete around prototypes, implementation, and limited engineering bandwidth."
    ],
    personalizationRules: [
      "Personalize around visible project types, feasibility work, or implementation bottlenecks.",
      "Avoid language that implies a larger team or consulting organization."
    ],
    avoidSignals: ["Generic transformation consulting language", "Treating them like a scaled integrator organization"]
  },
  integrator_general_ai: {
    category: "integrator_general_ai",
    label: "General AI integrator",
    researchPriorities: [
      "Identify where generic AI delivery can benefit from faster vision model cycles.",
      "Check if they implement projects, not only advise."
    ],
    outreachPriorities: ["Connect ONE WARE to project speed and predictability."],
    personalizationRules: ["Personalize around current delivery workflow gaps."],
    avoidSignals: ["Treating them as AI beginners"]
  },
  integrator_relevant_focus: {
    category: "integrator_relevant_focus",
    label: "Integrator with relevant vertical focus",
    researchPriorities: [
      "Pinpoint vertical-specific delivery bottlenecks and hardware constraints.",
      "Validate recurring vision/edge components."
    ],
    outreachPriorities: ["Anchor message in vertical project risk reduction."],
    personalizationRules: ["Use factual vertical hooks only."],
    avoidSignals: ["Over-generalized messaging"]
  },
  industrial_end_customer_scaled: {
    category: "industrial_end_customer_scaled",
    label: "Scaled industrial end customer",
    researchPriorities: [
      "Confirm production scale and internal engineering capability.",
      "Find QC, inspection, and process automation leverage points."
    ],
    outreachPriorities: ["Lead with economics, feasibility, and speed to production."],
    personalizationRules: ["Ground in concrete production context."],
    avoidSignals: ["Abstract transformation talk"]
  },
  camera_manufacturer_partner: {
    category: "camera_manufacturer_partner",
    label: "Camera manufacturer partner",
    researchPriorities: ["Validate partner fit and customer AI-enablement potential."],
    outreachPriorities: ["Focus on enabling customer-ready AI setups."],
    personalizationRules: ["Personalize with product-line evidence only."],
    avoidSignals: ["Positioning as replacement of core hardware business"]
  },
  machine_builder_ai_enablement: {
    category: "machine_builder_ai_enablement",
    label: "Machine builder AI enablement",
    researchPriorities: ["Validate OEM integration pathways, quality-control system portfolio, and customer-facing AI option potential."],
    outreachPriorities: ["Position ONE WARE as fast AI enablement layer for machine offerings and inspection-system upgrades."],
    personalizationRules: ["Use machine, inspection-system, or quality-control product context, not generic AI language."],
    avoidSignals: ["Ignoring mechanical integration realities"]
  },
  software_platform_embedding: {
    category: "software_platform_embedding",
    label: "Software platform embedding partner",
    researchPriorities: ["Validate embeddability and partner incentives."],
    outreachPriorities: ["Lead with integration leverage and user value lift."],
    personalizationRules: ["Tie outreach to concrete platform workflows."],
    avoidSignals: ["Overpromising without integration fit"]
  },
  irrelevant: {
    category: "irrelevant",
    label: "Irrelevant or excluded profile",
    researchPriorities: ["Capture disqualification reason."],
    outreachPriorities: ["Do not prepare outreach."],
    personalizationRules: ["Return concise exclusion reason."],
    avoidSignals: ["Forcing fit"]
  },
  other: {
    category: "other",
    label: "Mixed or unclear fit",
    researchPriorities: ["Resolve ambiguity conservatively."],
    outreachPriorities: ["Use cautious template-led messaging only if needed."],
    personalizationRules: ["Avoid overcommitment."],
    avoidSignals: ["Speculative assumptions"]
  }
};

export function getTemplateKeyForCategory(category: LeadCategory): string {
  switch (category) {
    case "integrator_vision_industrial_ai":
      return "integrator_vision_industrial_ai_template";
    case "integrator_vision_ai_consulting":
      return "integrator_vision_ai_consulting_template";
    case "integrator_vision_ai_freelancer":
      return "integrator_vision_ai_freelancer_template";
    case "integrator_general_ai":
      return "integrator_general_ai_template";
    case "integrator_relevant_focus":
      return "integrator_relevant_focus_template";
    case "industrial_end_customer_scaled":
      return "industrial_end_customer_scaled_template";
    case "camera_manufacturer_partner":
      return "camera_manufacturer_partner_template";
    case "machine_builder_ai_enablement":
      return "machine_builder_ai_enablement_template";
    case "software_platform_embedding":
      return "software_platform_embedding_template";
    default:
      return "integrator_vision_industrial_ai_template";
  }
}

export function getTemplateForCategory(category: LeadCategory): OutreachTemplate {
  return OUTREACH_TEMPLATES[getTemplateKeyForCategory(category)];
}

export function getExecutionContextForCategory(category: LeadCategory): CategoryExecutionContext {
  return CATEGORY_EXECUTION_CONTEXT[category];
}

export function buildMainContextBlock(mainContext?: string): string {
  return mainContext?.trim() || DEFAULT_MAIN_CONTEXT;
}

export function buildSearchStrategyContextBlock(searchStrategyContext?: string, mainContext?: string): string {
  return [
    "Main context:",
    buildMainContextBlock(mainContext),
    "Search strategy:",
    searchStrategyContext?.trim() || DEFAULT_SEARCH_STRATEGY_CONTEXT
  ].join("\n\n");
}

export function buildExecutionContextBlock(
  category: LeadCategory,
  mainContext?: string,
  override?: EditableExecutionContext
): string {
  const context = getExecutionContextForCategory(category);
  const mergedContext = {
    ...context,
    researchPriorities: override?.researchPriorities?.length ? override.researchPriorities : context.researchPriorities,
    outreachPriorities: override?.outreachPriorities?.length ? override.outreachPriorities : context.outreachPriorities,
    personalizationRules: override?.personalizationRules?.length ? override.personalizationRules : context.personalizationRules,
    avoidSignals: override?.avoidSignals?.length ? override.avoidSignals : context.avoidSignals
  };

  return [
    "Main context:",
    buildMainContextBlock(mainContext),
    `Category context: ${mergedContext.label}`,
    "Research priorities:",
    ...mergedContext.researchPriorities.map((item) => `- ${item}`),
    "Outreach priorities:",
    ...mergedContext.outreachPriorities.map((item) => `- ${item}`),
    "Personalization rules:",
    ...mergedContext.personalizationRules.map((item) => `- ${item}`),
    "Avoid signals:",
    ...mergedContext.avoidSignals.map((item) => `- ${item}`)
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildPrequalificationContextBlock(
  prequalification?: PrequalificationConfig,
  activeCategories?: LeadCategory[],
  mainContext?: string
): string {
  const activePositiveCategories = (activeCategories?.filter((category) => category !== "irrelevant" && category !== "other") ??
    Object.keys(DEFAULT_PREQUALIFICATION_CATEGORY_CONTEXTS)) as SelectableLeadCategory[];
  const activeCategorySet = new Set(activeCategories?.length ? [...activeCategories, "irrelevant", "other"] : Object.keys(CATEGORY_PREQUALIFICATION_CONTEXT));
  const categoryRules = Object.values(CATEGORY_PREQUALIFICATION_CONTEXT)
    .filter((context) => activeCategorySet.has(context.category))
    .map((context) => {
      const categoryOverride = context.category !== "irrelevant" && context.category !== "other"
        ? prequalification?.categoryContexts?.[context.category as SelectableLeadCategory]
        : undefined;
      const classificationRules = [
        ...context.classificationRules,
        ...(categoryOverride?.classificationRules ?? [])
      ];
      const disqualifiers = [
        ...context.disqualifiers,
        ...(categoryOverride?.disqualifiers ?? [])
      ];
      const categoryAddOn = categoryOverride?.addOnContext?.trim() ?? "";

      return [
        `Category: ${context.category} (${context.label})`,
        context.category !== "irrelevant" && context.category !== "other" && activePositiveCategories.includes(context.category as SelectableLeadCategory)
          ? "- Active for this run: yes"
          : context.category !== "irrelevant" && context.category !== "other"
            ? "- Active for this run: no"
            : undefined,
        ...classificationRules.map((rule) => `- Rule: ${rule}`),
        ...disqualifiers.map((rule) => `- Disqualifier: ${rule}`),
        categoryAddOn ? `- Operator add-on: ${categoryAddOn}` : undefined
      ].join("\n");
    })
    .join("\n\n");

  return [
    "Main context:",
    buildMainContextBlock(mainContext),
    activeCategories?.length ? `Active positive-match categories: ${activeCategories.join(", ")}` : undefined,
    prequalification?.mainContext?.trim() ? `Prequalification main operator context:\n${prequalification.mainContext.trim()}` : undefined,
    "Decision order:",
    "- Step 1: Identify the company archetype completely unbiased before assuming fit.",
    "- Step 2: Eliminate irrelevant archetypes such as media, publisher, magazine, VC, bank, recruiter, university, association, or event business immediately.",
    "- Step 3: For positive categories, require concrete evidence of delivery ownership, implementation responsibility, or a credible partner/embed path.",
    "- Step 4: If the company looks product-led, hardware-led, or robotics-led without service ownership, prefer machine_builder_ai_enablement, other, or irrelevant over an integrator category.",
    "Prequalification categories:",
    categoryRules
  ]
    .filter(Boolean)
    .join("\n\n");
}