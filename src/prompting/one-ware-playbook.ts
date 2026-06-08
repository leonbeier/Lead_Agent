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
  subjectEn?: string;
  emailBodyEn?: string;
  linkedInConnectionRequestEn?: string;
  linkedInMessageEn?: string;
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
  "Prioritize firms where public evidence suggests real delivery ownership, industrial deployment relevance, recurring implementation work, or a credible partner/embed path for ONE WARE. Start by identifying the firm archetype objectively before assuming fit. Generalize from concrete business-model evidence instead of from company-name examples. The most productive search clusters so far are Germany Machine Vision System Integrators, Germany Industrial Computer Vision Engineering Services, Germany Automation Software Integrators, and Germany Smart Factory Software Engineering Partners, so prefer those angles before widening. A probe is already acceptable when at least 15% of reviewed companies are relevant; below that, tighten the search terms and source types instead of broadening. Prefer service-led search terms such as project-based software integrator, system integrator, implementation, engineering services, automation software, embedded development, inspection integration, and industrial software projects. Keep the strongest signal keywords concrete: machine vision, industrial inspection, image processing, inline inspection, optical quality control, MES integration, SCADA integration, PLC software integration, OT integration, smart factory software, and industrial software engineering in Germany. Treat exclusions as equally important as positive terms: explicitly avoid hardware vendors, OEMs, publishers, media brands, pure consultancies, directory-like lists, marketplaces, and broad global aggregator pages. Default to internet research using official company sites, trade fair exhibitor lists, expo catalogs, partner pages, technical magazine coverage, and customer case studies to discover firms, then return only the official company websites. Avoid broadeners like AI solutions, manufacturing on its own, generic AI, broad software terms, or employee-range widening when they are likely to pull generic AI vendors, software companies, hardware brands, or other weak-fit profiles. Search broadly enough to discover strong-fit companies, then filter conservatively based on concrete signals rather than generic AI claims.";

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
      "Treat as relevant when the company builds machines, OEM systems, production equipment, industrial fixtures, hardware-centric inspection products, scanners, scan bars, imaging appliances, appliance-like products, or a single-purpose productized Vision-AI or radiology-AI application that could be improved as a shipped product. Medical-imaging or radiology AI plugins that are inserted into existing PACS/RIS or diagnostic workflows can still fit here when the monetization is the shipped application itself. If the main fit is that ONE WARE would be embedded into the company's own shipped software product, prefer this category over integrator buckets. Do not use this category for broad workflow platforms, marketplaces, or orchestration layers unless the software is mainly bundled with a shipped machine, appliance, or physical OEM product. Use machine_builder_vision_ai instead when Vision AI, machine vision, or computer vision inspection is already the primary purpose and core value proposition of their machines or systems."
  },
  machine_builder_vision_ai: {
    addOnContext:
      "Treat as relevant when Vision AI, machine vision, optical inspection, or computer vision is the primary purpose and core value proposition of the machines or systems the company ships. Examples: AOI machines, inline optical inspection systems, automated visual quality-control equipment, LiDAR sensing systems, 3D measurement systems, or machine-vision inspection stations where the visual sensing capability is what the machine is sold for. The key distinction from machine_builder_ai_enablement is that Vision AI must be what the machine IS, not just a feature that could be added. If the company's core product is an AOI machine, optical inspection station, LiDAR system, or machine vision product \u2014 even if they do not explicitly use the term 'Vision AI' \u2014 this is the right category. ONE WARE fits by improving model accuracy, handling difficult datasets, and enabling customer-specific model variants. Do not use this category when Vision AI is only a minor add-on on a machine whose primary purpose is something else such as packaging, CNC, assembly, or material handling. When in doubt between this category and machine_builder_ai_enablement, prefer machine_builder_vision_ai if optical inspection, AOI, or machine vision sensing is the dominant product description."
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
      "Hallo Herr/Frau [Name],\n\nSetzen Sie bereits Vision-AI-Projekte um oder erhalten entsprechende Anfragen von Kunden?\n\nWir haben eine neue Technologie entwickelt, mit der sich Vision-AI-Anwendungen deutlich schneller umsetzen lassen. Statt viel Zeit in Modellauswahl, Fine-Tuning und Optimierung zu investieren, können automatisch passende KI-Modelle für konkrete Anwendungen erzeugt werden.\n\nDadurch lassen sich auch Projekte adressieren, bei denen universelle KI-Modelle zu aufwendig, zu langsam oder nicht genau genug sind.\n\nIn einem gemeinsamen Whitepaper mit dem Chiphersteller Altera zeigen wir beispielsweise, dass sich KI-Modelle erzeugen lassen, die über 1000× schneller arbeiten und dabei 24× weniger Fehler verursachen als konventionelle Ansätze.\n\nFalls das interessant klingt, freue ich mich über einen kurzen Austausch.\n\nViele Grüße\n[Ihr Name]",
    linkedInConnectionRequest:
      "Hi [Name], ich bin Leon von ONE WARE. Ich habe gesehen, dass Sie KI-Projekte umsetzen. Wir arbeiten daran, die Entwicklung von Vision AI zu vereinfachen.",
    linkedInMessage:
      "Hi [Name], danke fürs Vernetzen.\n\nIch hatte gesehen, dass Sie KI-Projekte umsetzen. Bei Vision AI sehen wir oft, dass die Anwendungen spannend sind, die Entwicklung aber schnell deutlich komplexer wird als bei klassischen KI-Projekten. Es geht nicht nur um das Modell, sondern auch um Daten, Genauigkeit, Optimierung und Deployment auf der Zielhardware.\n\nWir haben deshalb eine Technologie entwickelt, bei der nicht die Anwendung um ein bestehendes KI-Modell herum optimiert werden muss. Stattdessen wird automatisch ein passendes Modell für den konkreten Anwendungsfall und die verfügbare Hardware erzeugt.\n\nDadurch lassen sich Vision-AI-Projekte schneller testen und einfacher umsetzen, auch ohne langen ML-Optimierungsprozess.\n\nIst Vision AI bei Ihnen aktuell ein Thema?",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie aktuell Vision-AI-Anwendungen bei Kunden umsetzen oder dort bereits Erfahrung haben. Falls ja: Wir haben eine Software, mit der deutlich schneller produktionsreife Vision-AI-Modelle erstellt werden können. Weil wir nicht jeden Integrations- und Beratungsanteil selbst abdecken können, sprechen wir mit Partnern, für die eine Zusammenarbeit sinnvoll sein könnte. Wäre das grundsätzlich interessant für Sie?",
    subjectEn: "Vision AI without long optimization cycles",
    emailBodyEn:
      "Hi [Name],\n\nare you already working on Vision AI projects or receiving customer requests in that area?\n\nWe often see that Vision AI projects are much more complex than typical AI applications. It is not just about the model, but also about data, accuracy, optimization and deployment on the target hardware.\n\nWe have developed a technology where the application does not need to be optimized around an existing AI model. Instead, a suitable model is generated automatically for the specific use case and available hardware.\n\nThis makes Vision AI projects faster to test and easier to implement, without turning every project into a long ML optimization process.\n\nIn a joint whitepaper with Altera, we showed that a generated model can run over 1000× faster while producing 24× fewer errors than a conventional approach.\n\nCould this be relevant for customer projects on your side?\n\nBest regards,\n[Your Name]",
    linkedInConnectionRequestEn:
      "Hi [Name], I'm Leon from ONE WARE. I saw that you work on AI projects. We're working on making Vision AI development easier and faster to implement.",
    linkedInMessageEn:
      "Hi [Name], thanks for connecting.\n\nI saw that you work on AI projects. With Vision AI, we often see that the use cases are promising, but development quickly becomes more complex than in typical AI projects. It is not just about the model, but also about data, accuracy, optimization and deployment on the target hardware.\n\nWe have developed a technology where the application does not need to be optimized around an existing AI model. Instead, a suitable model is generated automatically for the specific use case and available hardware.\n\nThis makes Vision AI projects faster to test and easier to implement, without turning every project into a long ML optimization process.\n\nIs Vision AI currently a topic in your projects?"
  },
  integrator_vision_ai_consulting_template: {
    key: "integrator_vision_ai_consulting_template",
    audience: "Vision AI / Industrial AI consulting firms and specialist boutiques with hands-on delivery ownership",
    goal: "Position ONE WARE as a force multiplier for consulting teams delivering industrial vision and inspection projects.",
    subject: "Vision-AI bei Industriekunden",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nich habe gesehen, dass Sie Unternehmen bei Digitalisierung und Automatisierung unterstützen.\n\nEin Thema, das bei Industriekunden oft hohen Wert hat, aber schwer umzusetzen ist, sind Vision-AI-Anwendungen, zum Beispiel für Qualitätskontrolle, Fehlererkennung oder Prozessüberwachung.\n\nWir entwickeln mit ONE AI eine Technologie, mit der solche Anwendungen deutlich schneller validiert und umgesetzt werden können. Statt lange an Modellauswahl, Fine-Tuning und Hardware-Optimierung zu arbeiten, wird automatisch ein passendes KI-Modell für die konkrete Aufgabe und Zielhardware erzeugt.\n\nIn einem gemeinsamen Whitepaper mit Altera konnten wir zeigen, dass ein erzeugtes Modell über 1000× schneller arbeitet und 24× weniger Fehler macht als ein konventioneller Ansatz.\n\nIch könnte mir vorstellen, dass das für einige Ihrer Industrieprojekte relevant sein kann.\n\nWäre ein kurzer Austausch dazu interessant?\n\nViele Grüße\n[Ihr Name]",
    linkedInConnectionRequest:
      "Hi [Name], ich bin Leon von ONE WARE. Ich habe gesehen, dass Sie Unternehmen bei Digitalisierung oder Automatisierung unterstützen. Wir arbeiten an schneller umsetzbarer Vision AI.",
    linkedInMessage:
      "Hi [Name], danke fürs Vernetzen.\n\nIch hatte gesehen, dass Sie Unternehmen bei Digitalisierung, Automatisierung oder technologischer Transformation unterstützen. Ein Thema, das bei Industriekunden oft hohen Wert hat, aber schwer umzusetzen ist, sind Vision-AI-Anwendungen, zum Beispiel für Qualitätskontrolle, Fehlererkennung oder Prozessüberwachung.\n\nIn der Praxis werden solche Projekte schnell komplex, weil Daten, Modellgenauigkeit, Optimierung und Zielhardware zusammenpassen müssen.\n\nWir haben eine Technologie entwickelt, bei der automatisch ein passendes KI-Modell für die konkrete Aufgabe und die verfügbare Hardware erzeugt wird. Dadurch lassen sich Vision-AI-Anwendungen schneller validieren und umsetzen, ohne dass jedes Projekt zu einem langen ML-Optimierungsprozess wird.\n\nKönnte das für Industrieprojekte bei Ihren Kunden relevant sein?",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie Vision-AI-Anwendungen aktuell für Kunden umsetzen oder in dem Bereich Erfahrung haben. Wir haben eine Software, mit der sich produktionsreife Vision-AI-Modelle deutlich schneller erstellen lassen. Da uns für die komplette Integrations- und Beratungsleistung nicht überall die Kapazität reicht, suchen wir gezielt nach Partnern für gemeinsame Projekte. Wäre so eine Zusammenarbeit für Sie grundsätzlich interessant?",
    subjectEn: "Vision AI for industrial customers",
    emailBodyEn:
      "Hi [Name],\n\nI saw that you support companies with digitalization and automation.\n\nOne area that can create a lot of value for industrial customers, but is often difficult to implement, is Vision AI, for example in quality control, defect detection or process monitoring.\n\nIn practice, these projects quickly become complex because data, model accuracy, optimization and target hardware all need to work together.\n\nWe have developed a technology that helps validate and implement these applications faster. Instead of spending a lot of time on model selection, fine-tuning and hardware optimization, a suitable AI model is generated automatically for the specific task and target hardware.\n\nIn a joint whitepaper with Altera, we showed that a generated model can run over 1000× faster while producing 24× fewer errors than a conventional approach.\n\nCould this be relevant for industrial projects with your customers?\n\nBest regards,\n[Your Name]",
    linkedInConnectionRequestEn:
      "Hi [Name], I'm Leon from ONE WARE. I saw that you support companies with digitalization or automation. We're working on Vision AI that is faster to implement.",
    linkedInMessageEn:
      "Hi [Name], thanks for connecting.\n\nI saw that you support companies with digitalization, automation or technology projects. One area that can create a lot of value for industrial customers, but is often hard to implement, is Vision AI, for example in quality control, defect detection or process monitoring.\n\nIn practice, these projects quickly become complex because data, model accuracy, optimization and target hardware all need to work together.\n\nWe have developed a technology that automatically generates a suitable AI model for the specific task and available hardware. This helps validate and implement Vision AI applications faster, without turning every project into a long ML optimization process.\n\nCould this be relevant for industrial projects with your customers?"
  },
  integrator_vision_ai_freelancer_template: {
    key: "integrator_vision_ai_freelancer_template",
    audience: "Independent Vision AI / Industrial AI freelancers and solo specialists with hands-on delivery ownership",
    goal: "Position ONE WARE as leverage for solo experts who need to deliver more with limited hands-on engineering time.",
    subject: "Schwierige Vision-AI-Anwendungen lösen",
    emailBody:
      "Hallo [Name],\n\nich habe gesehen, dass Sie Computer-Vision-Projekte umsetzen.\n\nWir entwickeln eine Technologie für Vision-AI-Anwendungen, bei denen Standardansätze an ihre Grenzen stoßen. Z.B. bei kleinen Datensätzen, sehr kleinen Objekten oder begrenzter Rechenleistung auf Edge-Hardware.\n\nStatt bestehende Foundation Models zu fine-tunen und die Anwendung um ein vorgegebenes Modell herum zu optimieren, erzeugt unsere Technologie für jeden Anwendungsfall ein maßgeschneidertes KI-Modell mit individueller Architektur. Dadurch entstehen zusätzliche Lösungsoptionen, wenn bekannte Modelle nicht die gewünschte Genauigkeit, Geschwindigkeit oder Effizienz liefern.\n\nIn einem gemeinsamen Whitepaper mit dem Chiphersteller Altera zeigen wir beispielsweise, dass sich KI-Modelle erzeugen lassen, die über 1000× schneller arbeiten und dabei 24× weniger Fehler verursachen als konventionelle Ansätze.\n\nHaben Sie aktuell Herausforderungen bei Vision-AI-Anwendungen oder gemerkt, dass konventionelle Ansätze an ihre Grenzen stoßen?\n\nViele Grüße\n[Ihr Name]",
    linkedInConnectionRequest:
      "Hi [Name], ich bin Leon von ONE WARE. Ich habe gesehen, dass Sie Computer-Vision-Projekte umsetzen. Wir arbeiten daran, schwierige Vision-AI-Anwendungen einfacher lösbar zu machen.",
    linkedInMessage:
      "Hi [Name], danke fürs Vernetzen.\n\nIch hatte gesehen, dass Sie Computer-Vision-Projekte umsetzen. Bei manchen Vision-AI-Anwendungen stoßen Standardansätze schnell an Grenzen, etwa bei kleinen Datensätzen, sehr kleinen Objekten, hohen Genauigkeitsanforderungen oder begrenzter Rechenleistung auf Edge-Hardware.\n\nWir haben eine Technologie entwickelt, bei der nicht die Anwendung um ein bestehendes Modell herum optimiert werden muss. Stattdessen wird automatisch ein passendes KI-Modell für den konkreten Anwendungsfall, die verfügbaren Daten und die Zielhardware erzeugt.\n\nDas ist besonders spannend, wenn Foundation Models oder klassische Computer-Vision-Ansätze nicht die gewünschte Genauigkeit, Geschwindigkeit oder Effizienz liefern.\n\nHaben Sie aktuell Projekte, bei denen bestehende Modelle an Grenzen stoßen?",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie Vision-AI-Anwendungen aktuell für Kunden umsetzen oder in dem Bereich Erfahrung haben. Wir haben eine Software, mit der deutlich schneller produktionsreife Vision-AI-Modelle erstellt werden können. Weil wir nicht jede Integrations- und Beratungsleistung selbst begleiten können, prüfen wir aktuell auch Partnerschaften mit erfahrenen Spezialisten. Wäre das für Sie grundsätzlich spannend?",
    subjectEn: "Solving difficult Vision AI applications",
    emailBodyEn:
      "Hi [Name],\n\nI saw that you work on computer vision projects.\n\nIn some Vision AI applications, standard approaches quickly reach their limits, for example with small datasets, very small objects, high accuracy requirements or limited compute on edge hardware.\n\nWe have developed a technology where the application does not need to be optimized around an existing model. Instead, a suitable AI model is generated automatically for the specific use case, available data and target hardware.\n\nThis creates an additional option when foundation models or classical computer vision approaches do not deliver the required accuracy, speed or efficiency.\n\nIn a joint whitepaper with Altera, we showed that a generated model can run over 1000× faster while producing 24× fewer errors than a conventional approach.\n\nDo you currently have Vision AI projects where existing models are reaching their limits?\n\nBest regards,\n[Your Name]",
    linkedInConnectionRequestEn:
      "Hi [Name], I'm Leon from ONE WARE. I saw that you work on computer vision projects. We're working on making difficult Vision AI applications easier to solve.",
    linkedInMessageEn:
      "Hi [Name], thanks for connecting.\n\nI saw that you work on computer vision projects. In some Vision AI applications, standard approaches quickly reach their limits, for example with small datasets, very small objects, high accuracy requirements or limited compute on edge hardware.\n\nWe have developed a technology where the application does not need to be optimized around an existing model. Instead, a suitable AI model is generated automatically for the specific use case, available data and target hardware.\n\nThis is especially useful when foundation models or classical computer vision approaches do not deliver the required accuracy, speed or efficiency.\n\nDo you currently have projects where existing models are reaching their limits?"
  },
  integrator_general_ai_template: {
    key: "integrator_general_ai_template",
    audience: "Software/automation integrators with general AI focus and delivery ownership",
    goal: "Pivot from generic AI messaging to concrete Vision AI delivery throughput and margin gains.",
    subject: "Vision-AI in Industrieanwendungen",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nich habe gesehen, dass Sie [Automatisierungslösungen / Bildverarbeitung / industrielle Prüfsysteme] für Industriekunden umsetzen.\n\nBekommen Sie bereits Anfragen zu KI-basierter Bildauswertung, Qualitätskontrolle oder Objekterkennung?\n\nViele dieser Projekte sind für Kunden wertvoll, aber in der Umsetzung deutlich aufwendiger als klassische Automatisierung oder regelbasierte Bildverarbeitung. Häufig braucht es ML-Know-how, viele Optimierungsschritte und eine passende Lösung für die Zielhardware.\n\nWir entwickeln mit ONE AI eine Technologie, die automatisch passende Vision-AI-Modelle für konkrete Anwendungen erzeugt. Dadurch lassen sich solche Projekte schneller testen und auf Industrie-PCs, Embedded-Systemen, Kameras oder FPGAs umsetzen.\n\nBei ersten Projekten können wir gemeinsam unterstützen, sodass Ihr Team die Technologie kennenlernt und spätere Anwendungen selbstständig umsetzen kann.\n\nWäre das grundsätzlich interessant für Sie?\n\nViele Grüße\n[Ihr Name]",
    linkedInConnectionRequest:
      "Hi [Name], ich bin Leon von ONE WARE. Ich habe gesehen, dass Sie Industrieautomation oder Bildverarbeitung umsetzen. Wir arbeiten daran, Vision-AI-Projekte einfacher integrierbar zu machen.",
    linkedInMessage:
      "Hi [Name], danke fürs Vernetzen.\n\nIch hatte gesehen, dass Sie Automatisierungslösungen, Bildverarbeitung oder industrielle Prüfsysteme für Kunden umsetzen. Bei solchen Projekten kommen zunehmend Anfragen zu KI-basierter Bildauswertung, Qualitätskontrolle oder Objekterkennung auf.\n\nViele dieser Anwendungen sind für Kunden wertvoll, werden in der Umsetzung aber schnell komplexer als klassische Automatisierung oder regelbasierte Bildverarbeitung. Häufig braucht es ML-Know-how, mehrere Optimierungsschritte und eine Lösung, die sauber auf der Zielhardware läuft.\n\nWir haben eine Technologie entwickelt, bei der automatisch passende Vision-AI-Modelle für konkrete Anwendungen und Hardware erzeugt werden. Dadurch lassen sich solche Projekte schneller testen und auf Industrie-PCs, Kameras, Embedded-Systemen oder FPGAs umsetzen.\n\nIst Vision AI bei Kundenanfragen bei Ihnen aktuell ein Thema?",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie bereits Vision-AI-Anwendungen für Kunden umsetzen oder das aktuell aufbauen. Wir haben eine Software, mit der Vision-AI-Modelle deutlich schneller produktionsreif werden. Da wir nicht alle Integrations- und Beratungsprojekte selbst stemmen können, suchen wir Gespräche mit Dienstleistern, bei denen eine Zusammenarbeit sinnvoll sein könnte. Wäre das für Sie ein Thema?",
    subjectEn: "Vision AI for industrial applications",
    emailBodyEn:
      "Hi [Name],\n\nI saw that you implement [automation solutions / machine vision systems / industrial inspection systems] for industrial customers.\n\nAre you already receiving requests for AI-based image analysis, quality control or object detection?\n\nMany of these projects are valuable for customers, but much more complex to implement than classical automation or rule-based machine vision. They often require ML expertise, several optimization steps and a solution that runs reliably on the target hardware.\n\nWe have developed a technology that automatically generates suitable Vision AI models for specific applications and hardware. This makes it easier to test and deploy projects on industrial PCs, cameras, embedded systems or FPGAs.\n\nFor initial projects, we can support your team so they can learn the technology and handle future applications more independently.\n\nCould this be relevant for your customers?\n\nBest regards,\n[Your Name]",
    linkedInConnectionRequestEn:
      "Hi [Name], I'm Leon from ONE WARE. I saw that you work on industrial automation or machine vision. We're working on making Vision AI projects easier to integrate.",
    linkedInMessageEn:
      "Hi [Name], thanks for connecting.\n\nI saw that you implement automation solutions, machine vision systems or industrial inspection systems for customers. In these projects, requests for AI-based image analysis, quality control or object detection are becoming more common.\n\nMany of these applications are valuable for customers, but they quickly become more complex than classical automation or rule-based machine vision. They often require ML expertise, several optimization steps and a solution that runs reliably on the target hardware.\n\nWe have developed a technology that automatically generates suitable Vision AI models for specific applications and hardware. This makes it easier to test these projects and deploy them on industrial PCs, cameras, embedded systems or FPGAs.\n\nIs Vision AI currently coming up in customer requests on your side?"
  },
  integrator_relevant_focus_template: {
    key: "integrator_relevant_focus_template",
    audience: "Software/automation integrators with relevant vertical focus (defence, surveillance, robotics, medtech vision, agriculture, automotive)",
    goal: "Connect ONE WARE to vertical delivery bottlenecks in vision-heavy customer projects.",
    subject: "Vision-AI auf FPGAs und Embedded-Hardware",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nich habe gesehen, dass Sie [Entwicklungsdienstleistungen für FPGAs und Bildverarbeitung / Embedded-Systeme / industrielle Elektronik] anbieten.\n\nWir entwickeln eine Technologie, mit der sich sehr effiziente Vision-AI-Modelle automatisch erzeugen und direkt als vendor-unabhängiger VHDL-Code exportieren lassen. Dadurch können Vision-AI-Modelle auch auf ressourcenbeschränkter Hardware umgesetzt werden, bei der herkömmliche Modelle zu groß, zu langsam oder zu ineffizient wären.\n\nIn einem gemeinsamen Whitepaper mit Altera zeigen wir beispielsweise ein automatisch erzeugtes Modell, das 1736 FPS auf einem Altera MAX10 FPGA erreicht:\nhttps://go.altera.com/l/1090322/2025-04-18/2vvzbn\n\nIch könnte mir vorstellen, dass dieser Ansatz interessant ist, wenn künftig KI-basierte Auswertung, Klassifikation oder Objekterkennung auf FPGA- oder Embedded-Hardware eine Rolle spielt.\n\nFalls das interessant klingt, freue ich mich über einen kurzen Austausch.\n\nViele Grüße\n[Ihr Name]",
    linkedInConnectionRequest:
      "Hi [Name], ich bin Leon von ONE WARE. Ich habe gesehen, dass Sie mit FPGAs oder Embedded-Systemen arbeiten. Wir erzeugen effiziente Vision-AI-Modelle automatisch als VHDL.",
    linkedInMessage:
      "Hi [Name], danke fürs Vernetzen.\n\nIch hatte gesehen, dass Sie im Bereich FPGA, Embedded-Systeme oder Bildverarbeitung arbeiten. Wir entwickeln eine Technologie, mit der sich sehr effiziente Vision-AI-Modelle automatisch erzeugen und direkt als vendor-unabhängiger VHDL-Code exportieren lassen.\n\nDadurch werden KI-basierte Auswertung, Klassifikation oder Objekterkennung auch auf FPGAs möglich, bei denen klassische Modelle zu groß, zu langsam oder zu ineffizient wären.\n\nIn einem gemeinsamen Whitepaper mit Altera zeigen wir zum Beispiel ein automatisch erzeugtes Modell, das 1736 FPS auf einem Altera MAX10 FPGA erreicht.\n\nKönnte das für FPGA- oder Embedded-Projekte bei Ihnen relevant sein?",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie schon Erfahrung damit gemacht haben, Vision AI zum Beispiel für Qualitätskontrolle in Projekte einzubauen. Genau dort helfen wir mit einer Software, mit der sich Vision-AI-Modelle deutlich schneller produktionsreif erstellen lassen. Weil wir nicht alle Integrationsprojekte selbst begleiten können, sprechen wir auch mit spezialisierten Partnern über mögliche Zusammenarbeit. Wäre das für Ihr Team grundsätzlich interessant?",
    subjectEn: "Vision AI on FPGAs without long iterations",
    emailBodyEn:
      "Hi [Name],\n\nI saw that you work on [FPGA development / embedded systems / image processing].\n\nWe have developed a technology that automatically generates highly efficient Vision AI models and exports them directly as vendor-independent VHDL code.\n\nThis makes AI-based inspection, classification or object detection possible on FPGAs where conventional models would be too large, too slow or too inefficient.\n\nIn a joint whitepaper with Altera, we show an automatically generated model running at 1736 FPS on an Altera MAX10 FPGA.\n\nCould this be relevant for FPGA or embedded projects on your side?\n\nBest regards,\n[Your Name]",
    linkedInConnectionRequestEn:
      "Hi [Name], I'm Leon from ONE WARE. I saw that you work with FPGAs or embedded systems. We automatically generate efficient Vision AI models as VHDL.",
    linkedInMessageEn:
      "Hi [Name], thanks for connecting.\n\nI saw that you work in FPGA, embedded systems or image processing. We develop a technology that automatically generates highly efficient Vision AI models and exports them directly as vendor-independent VHDL code.\n\nThis makes AI-based inspection, classification or object detection possible on FPGAs where conventional models would be too large, too slow or too inefficient.\n\nIn a joint whitepaper with Altera, we show an automatically generated model running at 1736 FPS on an Altera MAX10 FPGA.\n\nCould this be relevant for FPGA or embedded projects on your side?"
  },
  industrial_end_customer_scaled_template: {
    key: "industrial_end_customer_scaled_template",
    audience: "Industrial end customers with own production and sufficient scale for high-value QC/process-automation projects",
    goal: "Position ONE WARE as a fast and economical path to production-ready Vision AI for scaled operations.",
    subject: "Qualitätskontrolle und Prozessautomatisierung mit Vision AI",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nich habe gesehen, dass Ihr Unternehmen in der [Lebensmittelbranche / Verpackung / Fertigung] tätig ist.\n\nDort gibt es viele mögliche Anwendungen für Bildverarbeitung, zum Beispiel bei der Qualitätskontrolle, Sortierung oder Prozessautomatisierung.\n\nIn der Umsetzung werden solche Projekte aber schnell komplex. Egal ob mit klassischer Bildverarbeitung oder KI: Kamera, Hardwareaufbau, Daten und Software müssen zusammenpassen. Dadurch werden Projekte oft teurer und aufwendiger als geplant.\n\nWir haben eine Technologie entwickelt, bei der nicht die Anwendung um ein bestehendes KI-Modell herum optimiert werden muss. Stattdessen wird automatisch ein passendes Modell für den konkreten Anwendungsfall und die verfügbare Hardware erzeugt.\n\nDadurch lassen sich Projekte schneller und einfacher umsetzen, auch ohne eigene ML-Erfahrung. Für viele Anwendungen reicht ein schlankes Setup, zum Beispiel eine Industriekamera mit integriertem Prozessor, statt teurer Spezialhardware.\n\nKönnte das für Anwendungen in Ihrer Produktion relevant sein?\n\nViele Grüße\n[Ihr Name]",
    linkedInConnectionRequest:
      "Hi [Name], ich bin Leon von ONE WARE. Ich habe gesehen, dass Ihr Unternehmen in [Branche] tätig ist. Wir arbeiten daran, Vision AI für Qualitätskontrolle einfacher umzusetzen.",
    linkedInMessage:
      "Hi [Name], danke fürs Vernetzen.\n\nIch hatte gesehen, dass Ihr Unternehmen in [Lebensmittelbranche / Verpackung / Fertigung] tätig ist. Dort gibt es viele mögliche Anwendungen für Bildverarbeitung, zum Beispiel bei Qualitätskontrolle, Sortierung oder Prozessautomatisierung.\n\nIn der Umsetzung werden solche Projekte aber schnell komplex. Egal ob mit klassischer Bildverarbeitung oder KI: Kamera, Hardwareaufbau, Daten und Software müssen zusammenpassen. Dadurch werden Projekte oft teurer und aufwendiger als geplant.\n\nWir haben eine Technologie entwickelt, bei der nicht die Anwendung um ein bestehendes KI-Modell herum optimiert werden muss. Stattdessen wird automatisch ein passendes Modell für den konkreten Anwendungsfall und die verfügbare Hardware erzeugt.\n\nDadurch lassen sich Projekte schneller und einfacher umsetzen, auch ohne eigene ML-Erfahrung. Für viele Anwendungen reicht ein schlankes Setup, zum Beispiel eine Industriekamera mit integriertem Prozessor.\n\nKönnte das für Anwendungen in Ihrer Produktion relevant sein?",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Themen wie Qualitätskontrolle oder Prozessautomation bei Ihnen aktuell relevant sind. Wir haben die Erfahrung gemacht, dass sich Vision AI dafür oft mit deutlich weniger Aufwand und auf günstigerer Hardware umsetzen lässt, als viele erwarten. Wäre das bei Ihnen grundsätzlich interessant?",
    subjectEn: "Quality control and process automation with Vision AI",
    emailBodyEn:
      "Hi [Name],\n\nI saw that your company operates in [food production / packaging / manufacturing].\n\nIn these environments, there are many possible applications for machine vision, for example quality control, sorting or process automation.\n\nIn practice, these projects often become complex quickly. Whether using classical machine vision or AI, the camera setup, hardware, data and software all need to work together. This often makes projects more expensive and time-consuming than expected.\n\nWe have developed a technology where the application does not need to be optimized around an existing AI model. Instead, a suitable model is generated automatically for the specific use case and available hardware.\n\nThis makes projects faster and easier to implement, even without internal ML experience. For many applications, a lean setup is enough, for example an industrial camera with an integrated processor instead of expensive specialized hardware.\n\nCould this be relevant for applications in your production?\n\nBest regards,\n[Your Name]",
    linkedInConnectionRequestEn:
      "Hi [Name], I'm Leon from ONE WARE. I saw that your company operates in [industry]. We're working on making Vision AI for quality control easier to implement.",
    linkedInMessageEn:
      "Hi [Name], thanks for connecting.\n\nI saw that your company operates in [food production / packaging / manufacturing]. In these environments, there are many possible applications for machine vision, for example quality control, sorting or process automation.\n\nIn practice, these projects often become complex quickly. Whether using classical machine vision or AI, the camera setup, hardware, data and software all need to work together. This often makes projects more expensive and time-consuming than expected.\n\nWe have developed a technology where the application does not need to be optimized around an existing AI model. Instead, a suitable model is generated automatically for the specific use case and available hardware.\n\nThis makes projects faster and easier to implement, even without internal ML experience. For many applications, a lean setup is enough, for example an industrial camera with an integrated processor.\n\nCould this be relevant for applications in your production?"
  },
  camera_manufacturer_partner_template: {
    key: "camera_manufacturer_partner_template",
    audience: "Camera or imaging manufacturers that can offer AI-ready customer setups",
    goal: "Position ONE WARE as the software layer to enable AI-capable camera deployments for customers.",
    subject: "Vision-AI einfacher in Kamera- und Imaging-Lösungen integrieren",
    emailBody:
      "Hallo [Name],\n\nbei Kamera- und Imaging-Lösungen gibt es immer wieder Kunden, bei denen Standardmodelle für den konkreten Use Case nicht ausreichen oder der vorhandene Datensatz zu schwierig ist. Genau dann dauern Modellwahl und Optimierung oft viel zu lange.\n\nMit ONE WARE können Sie Ihren Kunden eine zusätzliche Option geben, mit der deutlich schneller das passende Vision-AI-Modell entsteht. Das ist besonders interessant, wenn Kunden spezielle Anforderungen haben und nicht mit einem Standardansatz weiterkommen.\n\nSo bekommen Ihre Kunden schneller ein belastbares Ergebnis und Sie können Vision AI leichter als Teil Ihrer Lösung anbieten.\n\nWäre ein kurzer Austausch interessant, ob das für Ihre Kunden sinnvoll sein könnte?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInConnectionRequest:
      "Hi [Name], ich bin Leon von ONE WARE. Ich habe gesehen, dass Sie Kameras oder Imaging-Systeme entwickeln. Wir helfen dabei, KI-fähige Setups für Ihre Kunden zu ermöglichen.",
    linkedInMessage:
      "Hi [Name], danke fürs Vernetzen.\n\nIch hatte gesehen, dass Sie Kameras oder Imaging-Systeme entwickeln. Bei Kunden entstehen oft Anwendungsfälle, bei denen Standardmodelle nicht ausreichen oder der Datensatz schwierig ist.\n\nMit ONE WARE können Sie Ihren Kunden eine zusätzliche Option geben, mit der deutlich schneller das passende Vision-AI-Modell entsteht. Das ist besonders interessant, wenn Kunden spezielle Anforderungen haben und nicht mit einem Standardansatz weiterkommen.\n\nKönnte das für Ihre Kunden interessant sein?",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie auch Kundenfälle haben, bei denen Standardmodelle für den konkreten Vision-Use-Case nicht ausreichen oder der Datensatz schwierig ist. Genau dafür haben wir mit ONE WARE eine zusätzliche Option, mit der Kunden schneller zum passenden Modell kommen. Wäre das für Sie interessant?",
    subjectEn: "Vision AI easier to integrate into camera and imaging solutions",
    emailBodyEn:
      "Hi [Name],\n\nI saw that you develop cameras or imaging systems.\n\nIn customer applications, there are often cases where standard models are not sufficient or the dataset is difficult to work with. In these situations, model selection and optimization often take far too long.\n\nWith ONE WARE, you can offer your customers an additional option to get a suitable Vision AI model much faster. This is particularly useful when customers have specific requirements and cannot move forward with a standard approach.\n\nWould a brief exchange be interesting to explore possible customer use cases?\n\nBest regards,\n[Your Name]",
    linkedInConnectionRequestEn:
      "Hi [Name], I'm Leon from ONE WARE. I saw that you develop cameras or imaging solutions. We help enable AI-ready setups for your customers.",
    linkedInMessageEn:
      "Hi [Name], thanks for connecting.\n\nI saw that you develop cameras or imaging systems. In customer applications, there are often cases where standard models are not sufficient or the dataset is too small or difficult.\n\nWith ONE WARE, you can offer your customers an additional option to get a suitable Vision AI model much faster. This is particularly useful when customers have specific requirements and cannot move forward with a standard approach.\n\nCould this be relevant for your customers?"
  },
  machine_builder_ai_enablement_template: {
    key: "machine_builder_ai_enablement_template",
    audience: "Machine builders, hardware vendors, or product teams with their own Vision-AI application",
    goal: "Position ONE WARE as an AI enablement layer for product teams shipping Vision AI without long model-development cycles.",
    subject: "Vision AI als Erweiterung für Ihre Maschinen",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nich habe gesehen, dass Sie Maschinen und Anlagen für [Branche / Anwendung] entwickeln.\n\nKI-basierte Bildauswertung kann dort eine interessante Erweiterung sein, zum Beispiel für die Qualitätskontrolle, Teileerkennung oder Prozessüberwachung.\n\nSchwierig wird es oft, wenn eine KI-Funktion nicht nur in einem Projekt funktionieren soll, sondern als Teil der Maschine bei verschiedenen Kunden. Unterschiedliche Teile, Materialien, Lichtverhältnisse oder Qualitätskriterien führen schnell dazu, dass Anpassungen notwendig werden.\n\nWir haben eine Technologie entwickelt, bei der automatisch passende KI-Modelle für den jeweiligen Anwendungsfall und die verfügbare Hardware erzeugt werden. Dadurch muss nicht die Maschine um ein bestehendes Modell herum optimiert werden.\n\nDas kann sowohl für vortrainierte KI-Funktionen in Ihren Maschinen interessant sein als auch für Anwendungen, bei denen Kunden später eigene Varianten oder Prüfaufgaben erstellen möchten.\n\nSo lassen sich Vision-AI-Funktionen einfacher integrieren, ohne dass jedes Kundenprojekt zu einem eigenen aufwendigen ML-Projekt wird.\n\nKönnte das für zukünftige Maschinenfunktionen bei Ihnen relevant sein?\n\nViele Grüße\n[Ihr Name]",
    linkedInConnectionRequest:
      "Hi [Name], ich bin Leon von ONE WARE. Ich habe gesehen, dass Sie Maschinen für [Branche] entwickeln. Wir arbeiten daran, Vision-AI-Funktionen einfacher in Maschinen zu integrieren.",
    linkedInMessage:
      "Hi [Name], danke fürs Vernetzen.\n\nIch hatte gesehen, dass Sie Maschinen und Anlagen für [Branche / Anwendung] entwickeln. KI-basierte Bildauswertung kann dort eine interessante Erweiterung sein, zum Beispiel für Qualitätskontrolle, Teileerkennung oder Prozessüberwachung.\n\nSchwierig wird es oft, wenn eine KI-Funktion nicht nur in einem einzelnen Projekt funktionieren soll, sondern als Teil der Maschine bei verschiedenen Kunden. Unterschiedliche Teile, Materialien, Lichtverhältnisse oder Qualitätskriterien führen schnell dazu, dass Anpassungen notwendig werden.\n\nWir haben eine Technologie entwickelt, bei der automatisch passende KI-Modelle für den jeweiligen Anwendungsfall und die verfügbare Hardware erzeugt werden. Dadurch muss nicht die Maschine um ein bestehendes Modell herum optimiert werden.\n\nDas kann sowohl für vortrainierte KI-Funktionen in Ihren Maschinen interessant sein als auch für Anwendungen, bei denen Kunden später eigene Varianten oder Prüfaufgaben erstellen möchten.\n\nKönnte das für zukünftige Maschinenfunktionen bei Ihnen relevant sein?",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie Kundenprojekte haben, bei denen Standardmodelle für den konkreten Vision-Use-Case nicht ausreichen oder der Datensatz schwierig ist. Mit ONE WARE kann man für solche Fälle schneller das passende Modell finden und als zusätzliche Option in Produkte oder Maschinen integrieren. Wäre das bei Ihnen ein Thema?",
    subjectEn: "Vision AI as an extension for your machines",
    emailBodyEn:
      "Hi [Name],\n\nI saw that you develop machines and systems for [industry / application].\n\nAI-based image analysis could be an interesting extension, for example for quality control, part detection or process monitoring.\n\nIt often becomes difficult when an AI function is not meant to work in just one project, but as part of a machine across different customers. Different parts, materials, lighting conditions or quality criteria can quickly require adjustments.\n\nWe have developed a technology that automatically generates suitable AI models for the specific use case and available hardware. This means the machine does not need to be optimized around an existing model.\n\nThis can be useful both for pre-trained AI functions in your machines and for applications where customers later want to create their own variants or inspection tasks.\n\nThis makes Vision AI functions easier to integrate without turning every customer case into a separate ML project.\n\nCould this be relevant for future machine functions on your side?\n\nBest regards,\n[Your Name]",
    linkedInConnectionRequestEn:
      "Hi [Name], I'm Leon from ONE WARE. I saw that you build machines for [industry]. We're working on making Vision AI functions easier to integrate into machines.",
    linkedInMessageEn:
      "Hi [Name], thanks for connecting.\n\nI saw that you develop machines and systems for [industry / application]. AI-based image analysis could be an interesting extension, for example for quality control, part detection or process monitoring.\n\nIt often becomes difficult when an AI function is not meant to work in just one project, but as part of a machine across different customers. Different parts, materials, lighting conditions or quality criteria can quickly require adjustments.\n\nWe have developed a technology that automatically generates suitable AI models for the specific use case and available hardware. This means the machine does not need to be optimized around an existing model.\n\nThis can be useful both for pre-trained AI functions in your machines and for applications where customers later want to create their own variants or inspection tasks.\n\nCould this be relevant for future machine functions on your side?"
  },
  machine_builder_vision_ai_template: {
    key: "machine_builder_vision_ai_template",
    audience: "Machine builders that already ship machines with Vision AI or machine vision as a core product feature",
    goal: "Position ONE WARE as an option to solve demanding Vision AI applications where existing models reach their limits.",
    subject: "Vision-AI-Modelle für anspruchsvolle Anwendungen",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nIch habe gesehen, dass Sie bereits Maschinen [für die visuelle Qualitätskontrolle] entwickeln.\n\nGerade bei anspruchsvollen Anwendungen stoßen bestehende Ansätze aber oft an Grenzen, zum Beispiel bei kleinen Datensätzen, sehr kleinen Objekten, hohen Genauigkeitsanforderungen oder begrenzter Rechenleistung auf Edge-Hardware.\n\nWir haben eine Technologie entwickelt, bei der nicht die Anwendung um ein bestehendes Modell herum optimiert werden muss. Stattdessen wird automatisch ein passendes KI-Modell für die konkrete Aufgabe, die verfügbaren Daten und die Zielhardware erzeugt.\n\nDadurch entsteht eine zusätzliche Lösungsoption für Anwendungen, bei denen Foundation Models oder klassische Computer-Vision-Ansätze nicht die gewünschte Genauigkeit, Geschwindigkeit oder Effizienz liefern.\n\nIn einem gemeinsamen Whitepaper mit Altera konnten wir beispielsweise zeigen, dass ein erzeugtes Modell über 1000× schneller arbeitet und 24× weniger Fehler macht als ein konventioneller Ansatz.\n\nHaben Sie aktuell Vision-AI-Anwendungen, bei denen bestehende Modelle an Grenzen stoßen oder der Optimierungsaufwand sehr hoch ist?\n\nViele Grüße\n[Ihr Name]",
    linkedInConnectionRequest:
      "Hi [Name], ich bin Leon von ONE WARE. Ich habe gesehen, dass Sie bereits Maschinen mit Vision AI entwickeln. Wir arbeiten an Modellen für anspruchsvolle Vision-AI-Anwendungen.",
    linkedInMessage:
      "Hi [Name], danke fürs Vernetzen.\n\nIch hatte gesehen, dass Sie bereits Maschinen mit Bildverarbeitung oder Vision-AI-Funktionen entwickeln. Gerade bei anspruchsvollen Anwendungen stoßen bestehende Ansätze oft an Grenzen, zum Beispiel bei kleinen Datensätzen, sehr kleinen Objekten, hohen Genauigkeitsanforderungen oder begrenzter Rechenleistung auf Edge-Hardware.\n\nWir haben eine Technologie entwickelt, bei der nicht die Anwendung um ein bestehendes Modell herum optimiert werden muss. Stattdessen wird automatisch ein passendes KI-Modell für die konkrete Aufgabe, die verfügbaren Daten und die Zielhardware erzeugt.\n\nDadurch entsteht eine zusätzliche Lösungsoption für Anwendungen, bei denen Foundation Models oder klassische Computer-Vision-Ansätze nicht die gewünschte Genauigkeit, Geschwindigkeit oder Effizienz liefern.\n\nHaben Sie aktuell Vision-AI-Anwendungen, bei denen bestehende Modelle an Grenzen stoßen?",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Sie bei Ihren Vision-AI-Maschinen aktuell Grenzen erleben, etwa bei der Modellgenauigkeit, schwierigen Datensätzen oder hohem Optimierungsaufwand. Genau dort bieten wir eine zusätzliche Option. Wäre das relevant für Sie?",
    subjectEn: "Vision AI models for demanding applications",
    emailBodyEn:
      "Hi [Name],\n\nI saw that you already develop machines with machine vision or Vision AI functions.\n\nIn demanding applications, existing approaches often reach their limits, for example with small datasets, very small objects, high accuracy requirements or limited compute on edge hardware.\n\nWe have developed a technology where the application does not need to be optimized around an existing model. Instead, a suitable AI model is generated automatically for the specific task, available data and target hardware.\n\nThis creates an additional option for applications where foundation models or classical computer vision approaches do not deliver the required accuracy, speed or efficiency.\n\nIn a joint whitepaper with Altera, we showed that a generated model can run over 1000× faster while producing 24× fewer errors than a conventional approach.\n\nDo you currently have Vision AI applications where existing models are reaching their limits or the optimization effort is very high?\n\nBest regards,\n[Your Name]",
    linkedInConnectionRequestEn:
      "Hi [Name], I'm Leon from ONE WARE. I saw that you already build machines with Vision AI. We're working on models for demanding Vision AI applications.",
    linkedInMessageEn:
      "Hi [Name], thanks for connecting.\n\nI saw that you already develop machines with machine vision or Vision AI functions. In demanding applications, existing approaches often reach their limits, for example with small datasets, very small objects, high accuracy requirements or limited compute on edge hardware.\n\nWe have developed a technology where the application does not need to be optimized around an existing model. Instead, a suitable AI model is generated automatically for the specific task, available data and target hardware.\n\nThis creates an additional option for applications where foundation models or classical computer vision approaches do not deliver the required accuracy, speed or efficiency.\n\nDo you currently have Vision AI applications where existing models are reaching their limits?"
  },
  software_platform_embedding_template: {
    key: "software_platform_embedding_template",
    audience: "Software platforms that can embed ONE WARE as model-generation alternative (e.g. Roboflow-like)",
    goal: "Position ONE WARE as embeddable model-generation backend for platform providers.",
    subject: "Embeddable Vision-AI Modell-Engine für Ihre Plattform",
    emailBody:
      "Hallo [Name],\n\nwenn Nutzer einer Plattform mit Vision AI arbeiten, gibt es fast immer Fälle, in denen Standardmodelle nicht gut genug sind oder der Datensatz schwierig ist. Dann wird genau die Modellerstellung schnell zum Engpass.\n\nONE WARE kann hier als zusätzliche Option eingebettet werden, damit für den jeweiligen Use Case schneller das beste Modell entsteht. Das ist besonders wertvoll für Plattformen, die ihren Kunden nicht nur Standardmodelle, sondern den schnellsten Weg zu einem wirklich passenden Ergebnis bieten wollen.\n\nWäre ein kurzer technischer Austausch sinnvoll, ob das als Erweiterung für Ihre Plattform interessant ist?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInConnectionRequest:
      "Hi [Name], ich bin Leon von ONE WARE. Ich habe gesehen, dass Sie eine Software-Plattform betreiben. Wir bieten eine embeddable Vision-AI Modell-Engine.",
    linkedInMessage:
      "Hi [Name], danke fürs Vernetzen.\n\nIch hatte gesehen, dass Sie eine Software-Plattform betreiben, über die Nutzer mit Vision AI arbeiten. Dabei gibt es oft Fälle, bei denen Standardmodelle nicht ausreichen oder der Datensatz schwierig ist.\n\nONE WARE kann als zusätzliche Modell-Engine eingebettet werden, damit Nutzer für den jeweiligen Use Case schneller das beste Modell erhalten.\n\nWäre ein kurzer technischer Austausch sinnvoll, ob das für Ihre Plattform interessant sein könnte?",
    phoneScript:
      "Hallo Herr/Frau [Name], hier ist [Ihr Name] von ONE WARE. Ich wollte kurz fragen, ob Ihre Nutzer auch Fälle haben, in denen Standardmodelle nicht ausreichen oder der Datensatz schwierig ist. Genau dort kann ONE WARE als zusätzliche Modelloption interessant sein, damit Nutzer schneller zum besten Ergebnis kommen. Wäre das für Ihre Plattform relevant?",
    subjectEn: "Embeddable Vision AI model engine for your platform",
    emailBodyEn:
      "Hi [Name],\n\nIf your platform provides Vision AI workflows for users, model generation is often the most time-intensive step.\n\nONE WARE can be embedded here as an additional model engine, turning data into production-ready, hardware-optimized models in minutes.\n\nThis gives your users an additional option to get the best model for their specific use case faster.\n\nWould a brief technical exchange make sense to explore integration options?\n\nBest regards,\n[Your Name]",
    linkedInConnectionRequestEn:
      "Hi [Name], I'm Leon from ONE WARE. I saw that you operate a software platform. We offer an embeddable Vision AI model engine.",
    linkedInMessageEn:
      "Hi [Name], thanks for connecting.\n\nI saw that you operate a software platform where users work with Vision AI. There are often cases where standard models are not sufficient or the dataset is difficult.\n\nONE WARE can be embedded as an additional model engine so users get the best model for their specific use case faster.\n\nWould a brief technical exchange be interesting?"
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
      "Relevance is strongest when the company could offer AI as an option, module, retrofit, performance upgrade, or product improvement to customers. Single-purpose clinical or radiology AI products can also fit when the monetization is the shipped application itself rather than a platform layer; do not reject them merely because they operate in healthcare.",
      "Use machine_builder_vision_ai instead when Vision AI is already a core explicit feature of their current machines."
    ],
    disqualifiers: ["Pure distributor without machine-building capability", "Component seller with no system integration ownership", "No visible OEM, industrial equipment, or concrete shipped product context", "Broad workflow platform or marketplace with no single shipped product focus"]
  },
  machine_builder_vision_ai: {
    category: "machine_builder_vision_ai",
    label: "Machine builders with existing Vision AI",
    classificationRules: [
      "Relevant when Vision AI, machine vision, optical inspection, LiDAR sensing, or computer vision is the primary purpose and core value proposition of the machines or systems the company ships.",
      "Examples: AOI systems, inline optical inspection machines, automated visual quality-control equipment, LiDAR sensor systems, 3D measurement machines, machine-vision inspection stations branded around camera- or AI-based image analysis.",
      "Do NOT require the explicit term 'Vision AI' — if the product is an AOI machine, optical inspection station, or machine vision system, this category applies even when the company uses classical/non-AI imaging language.",
      "Distinct from machine_builder_ai_enablement: here Vision AI or machine vision sensing IS what the machine IS, not something that could be added later. The company actively faces challenges with model accuracy, edge cases, or customer-specific variants.",
      "Do not use when Vision AI is only a minor add-on feature of a machine whose primary function is something else such as packaging, assembly, CNC, or material handling."
    ],
    disqualifiers: ["Machine builder where Vision AI is not the primary purpose of the product", "Pure service integrator with no own shipped machine", "Hardware vendor without Vision AI or machine vision as a core product feature", "Machine where Vision AI is only an optional or minor add-on"]
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
      "Start from the segment template and personalize only where there is a clear factual hook.",
      "Retain template backbone and ONE WARE USP wording. Replace [Name] with the contact name, [Branche] with the actual industry, and application-specific placeholders with evidence from the company profile.",
      "Personalization should point to a concrete delivery bottleneck, use case, or market signal — not generic flattery."
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
      "Start from the segment template — stay close to original wording and structure.",
      "Fill in [Name] with the contact name, [Branche] with the actual vertical, and application-specific placeholders with evidence from the company profile.",
      "Personalize around visible project types, feasibility work, or implementation bottlenecks only where a clear factual hook exists."
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
      "Start from the segment template — stay close to original wording and structure.",
      "Fill in [Name] with the contact name, [Branche] with the actual vertical, and application-specific placeholders with concrete company evidence.",
      "Personalize around visible project types or implementation bottlenecks only where a factual hook exists. Avoid language implying a larger team."
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
    personalizationRules: ["Start from the segment template. Fill in [Name] with the contact name, [Branche] with the actual industry. Personalize only around concrete delivery workflow gaps."],
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
    personalizationRules: ["Start from the segment template. Fill in [Name] with the contact name, [Branche] with the actual vertical. Use factual vertical hooks only — no generic messaging."],
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
    personalizationRules: ["Start from the segment template. Fill in [Name] with the contact name, [Branche] with the actual production sector or product line. Ground personalization in concrete production context only."],
    avoidSignals: ["Abstract transformation talk"]
  },
  camera_manufacturer_partner: {
    category: "camera_manufacturer_partner",
    label: "Camera manufacturer partner",
    researchPriorities: ["Validate partner fit and customer AI-enablement potential."],
    outreachPriorities: ["Focus on enabling customer-ready AI setups."],
    personalizationRules: ["Start from the segment template. Fill in [Name] with the contact name, [Branche] with the specific camera or imaging vertical. Personalize with product-line evidence only."],
    avoidSignals: ["Positioning as replacement of core hardware business"]
  },
  machine_builder_ai_enablement: {
    category: "machine_builder_ai_enablement",
    label: "Machine builder AI enablement",
    researchPriorities: ["Validate OEM integration pathways, quality-control system portfolio, and customer-facing AI option potential."],
    outreachPriorities: ["Position ONE WARE as fast AI enablement layer for machine offerings and inspection-system upgrades."],
    personalizationRules: ["Start from the segment template. Fill in [Name] with the contact name, [Branche/Anwendung] with the actual machine type or inspection domain. Use machine, inspection-system, or quality-control product context — not generic AI language."],
    avoidSignals: ["Ignoring mechanical integration realities"]
  },
  machine_builder_vision_ai: {
    category: "machine_builder_vision_ai",
    label: "Machine builder with existing Vision AI",
    researchPriorities: [
      "Validate that the company already ships machines with Vision AI or machine vision as a core feature.",
      "Look for evidence of model accuracy limitations, difficult datasets, customer-specific adaptation challenges, or edge-hardware constraints."
    ],
    outreachPriorities: [
      "Lead with the angle of solving difficult Vision AI cases where existing models reach their limits.",
      "Position ONE WARE as an additional option alongside foundation models for harder applications."
    ],
    personalizationRules: [
      "Reference their specific Vision AI domain (quality control, inspection, etc.) and frame ONE WARE as improving what they already do.",
      "Avoid suggesting they are new to Vision AI."
    ],
    avoidSignals: ["Treating them as beginners to Vision AI", "Generic AI enablement language"]
  },
  software_platform_embedding: {
    category: "software_platform_embedding",
    label: "Software platform embedding partner",
    researchPriorities: ["Validate embeddability and partner incentives."],
    outreachPriorities: ["Lead with integration leverage and user value lift."],
    personalizationRules: ["Start from the segment template. Fill in [Name] with the contact name. Tie any personalization to concrete platform workflows or user-facing integration surfaces."],
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
    case "machine_builder_vision_ai":
      return "machine_builder_vision_ai_template";
    case "software_platform_embedding":
      return "software_platform_embedding_template";
    default:
      return "integrator_vision_industrial_ai_template";
  }
}

export function getTemplateForCategory(category: LeadCategory): OutreachTemplate {
  return OUTREACH_TEMPLATES[getTemplateKeyForCategory(category)];
}

function normalizeExecutionContextCategory(category: LeadCategory | string | undefined): SelectableLeadCategory {
  const normalizedCategory = category?.trim().toLowerCase();

  if (normalizedCategory === "integrator_vision_ai_consulting_freelancer") {
    return "integrator_vision_ai_consulting";
  }

  if (normalizedCategory && normalizedCategory in CATEGORY_EXECUTION_CONTEXT) {
    return normalizedCategory as SelectableLeadCategory;
  }

  return "integrator_general_ai";
}

export function getExecutionContextForCategory(category: LeadCategory | string): CategoryExecutionContext {
  return CATEGORY_EXECUTION_CONTEXT[normalizeExecutionContextCategory(category)];
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
  category: LeadCategory | string,
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