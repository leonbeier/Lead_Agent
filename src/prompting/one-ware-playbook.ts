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
  "Prioritize firms where public evidence suggests real delivery ownership, industrial deployment relevance, recurring implementation work, or a credible partner/embed path for ONE WARE. Start by identifying the firm archetype objectively before assuming fit. Prefer service-led search terms such as system integrator, implementation, engineering services, automation software, embedded development, inspection integration, and industrial software projects. Avoid broad keywords like robotics, AI, media, or platform on their own when they are likely to pull product vendors, publishers, investors, or other weak-fit profiles. Search broadly enough to discover strong-fit companies, then filter conservatively based on concrete signals rather than generic AI claims.";

export const DEFAULT_PREQUALIFICATION_MAIN_CONTEXT =
  "Decide relevance conservatively and completely unbiased. First identify the company archetype: implementation-led integrator, industrial end customer, camera/imaging manufacturer, machine builder/OEM, software platform, or clearly irrelevant profile such as media, publisher, event, association, university, research institute, VC, investor, bank, insurer, recruiter, reseller, or generic consultancy. A company is relevant only when there is evidence for real delivery ownership, industrial applicability, or a credible ONE WARE partner path. Reject weak-fit finance, recruiting, HR, generic non-industrial SaaS, vague consulting profiles without implementation responsibility, and product-led robotics or hardware brands when no delivery ownership is visible.";

export const DEFAULT_PREQUALIFICATION_CATEGORY_CONTEXTS: Record<SelectableLeadCategory, EditablePrequalificationCategoryContext> = {
  integrator_vision_industrial_ai: {
    addOnContext:
      "Require explicit evidence for Vision AI, machine vision, industrial inspection, edge AI deployment, or comparable delivery work. Relevance is strongest when the company implements custom projects for customers instead of just reselling products. Do not use this category for robot makers, OEMs, or hardware brands unless customer implementation services are clearly part of the business."
  },
  integrator_general_ai: {
    addOnContext:
      "Only treat as relevant when the company clearly delivers AI projects and there is a plausible path into Vision AI or industrial deployment. Generic AI branding alone is not enough."
  },
  integrator_relevant_focus: {
    addOnContext:
      "Require both project-delivery ownership and a relevant vertical such as surveillance, medtech vision, agriculture tech, defence, automotive, or industrial automation. The vertical should make camera-, inspection-, or edge-AI use cases plausible. Do not use the category only because the company sells robots, drone products, or hardware into one of these verticals."
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
      "Treat as relevant when the company builds machines, OEM systems, production equipment, or industrial fixtures and could add Vision AI as an option or product enhancement. Require real machine-building capability, not just distribution."
  },
  software_platform_embedding: {
    addOnContext:
      "Treat as relevant when the company operates a software platform with a credible integration surface where ONE WARE could be embedded as a model-generation backend. Require an actual platform product or workflow layer, not a services-only company."
  }
};

export const OUTREACH_TEMPLATES: Record<string, OutreachTemplate> = {
  integrator_vision_industrial_ai_template: {
    key: "integrator_vision_industrial_ai_template",
    audience: "Software/automation integrators with clear Vision AI or Industrial AI delivery focus",
    goal: "Position ONE WARE as a delivery multiplier for recurring industrial Vision AI projects.",
    subject: "Vision-AI ohne lange Optimierungsphasen",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nArbeiten Sie aktuell an Vision-AI-Projekten, bei denen es viele Iterationen braucht, bis ein Modell einsatzbereit ist – oder es trotz mehrerer Versuche nicht zuverlässig funktioniert?\n\nGenau das sehen wir häufig bei Integratoren: Wochen bis Monate fließen in Tuning und Deployment, statt in die eigentliche Lösung.\n\nWir haben dafür eine Software entwickelt, mit der sich individuelle Vision-AI-Modelle in unter 5 Minuten erzeugen und direkt produktionsbereit einsetzen lassen. Dadurch können Teams deutlich schneller iterieren, Projektlaufzeiten besser planen und mit dem gleichen Team mehr Projekte umsetzen.\n\nMich würde interessieren: Wo liegt bei Ihnen aktuell der größte Engpass in Vision-AI-Projekten – eher in der Modellgenerierung oder in der Integration?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInMessage:
      "Kurze Frage: Wie schnell bekommen Sie aktuell ein Vision-AI-Modell produktionsbereit? Ich sehe bei Integratoren oft, dass Modellwahl und Optimierung unnötig viel Zeit kosten. Wir automatisieren genau diesen Teil. Wie ist das bei Ihnen aktuell?",
    phoneScript:
      "Hallo Herr/Frau [Name], [Ihr Name] von ONE WARE hier. Ich mache es kurz – passt es gerade für 30 Sekunden? Wir sprechen aktuell mit Integratoren, bei denen Modellwahl und Optimierung in Vision-AI-Projekten Wochen oder Monate kosten. Wir automatisieren genau diesen Teil. Wie ist das bei Ihnen aktuell?"
  },
  integrator_general_ai_template: {
    key: "integrator_general_ai_template",
    audience: "Software/automation integrators with general AI focus and delivery ownership",
    goal: "Pivot from generic AI messaging to concrete Vision AI delivery throughput and margin gains.",
    subject: "AI-Projekte schneller zu produktionsreifer Vision-AI machen",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nViele Teams mit allgemeinem AI-Fokus sehen in Vision-Projekten denselben Engpass: Modellwahl, Optimierung und deploymentnahe Anpassungen ziehen sich oft länger als geplant.\n\nONE WARE automatisiert genau diesen Teil. Aus Ihren Daten entstehen in Minuten produktionsreife Vision-AI-Modelle, optimiert für die Zielhardware.\n\nSo lassen sich mehr Kundenprojekte mit dem gleichen Team liefern, bei besser planbaren Laufzeiten.\n\nWäre ein kurzer Austausch sinnvoll, um zu prüfen, ob das für Ihre laufenden Delivery-Projekte relevant ist?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInMessage:
      "Kurze Frage: Wo liegt bei Ihnen aktuell der größte Engpass bei Vision-AI-Projekten – eher in der Modellgenerierung oder in der Integration? Genau diesen Schritt automatisieren wir.",
    phoneScript:
      "Hallo Herr/Frau [Name], [Ihr Name] von ONE WARE. Wir sprechen mit AI-Dienstleistern, bei denen Vision-Projekte in Modellwahl und Optimierung zu viel Zeit kosten. Genau das automatisieren wir. Ist das bei Ihnen ein Thema?"
  },
  integrator_relevant_focus_template: {
    key: "integrator_relevant_focus_template",
    audience: "Software/automation integrators with relevant vertical focus (defence, surveillance, robotics, medtech vision, agriculture, automotive)",
    goal: "Connect ONE WARE to vertical delivery bottlenecks in vision-heavy customer projects.",
    subject: "Vision-AI in projektnahen Verticals schneller und planbarer liefern",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nIn vertikalen Projekten wie Defence, Surveillance, Robotik oder Medtech ist Vision-AI oft der kritische Pfad – und genau dort kosten Modellwahl und Optimierung überproportional viel Zeit.\n\nMit ONE WARE lassen sich anwendungsspezifische Vision-Modelle in Minuten statt Monaten erzeugen und direkt auf Zielhardware deployen.\n\nDadurch werden Delivery-Risiken kleiner und Projektlaufzeiten planbarer.\n\nWenn Sie möchten, prüfen wir an einem realen Use Case, wo sich der größte Hebel bei Ihnen ergibt.\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInMessage:
      "Kurze Frage: Haben Sie in Ihren Vertical-Projekten aktuell Vision-AI-Workstreams, die durch Modellwahl und Tuning ausgebremst werden? Genau dort setzen wir an.",
    phoneScript:
      "Hallo Herr/Frau [Name], [Ihr Name] von ONE WARE. Wir helfen Integratoren mit anspruchsvollen Verticals dabei, Vision-AI-Projekte schneller produktionsreif zu machen. Ist das bei Ihnen aktuell relevant?"
  },
  industrial_end_customer_scaled_template: {
    key: "industrial_end_customer_scaled_template",
    audience: "Industrial end customers with own production and sufficient scale for high-value QC/process-automation projects",
    goal: "Position ONE WARE as a fast and economical path to production-ready Vision AI for scaled operations.",
    subject: "Qualitätskontrolle und Vision-AI wirtschaftlicher umsetzen",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nBei vielen Industrieprojekten sehen wir, dass Vision-AI für Qualitätskontrolle oder Prozessautomation grundsätzlich sinnvoll wäre, die Umsetzung aber zu teuer, zu langsam oder technisch zu aufwendig wird.\n\nGenau dort setzen wir an: Mit ONE WARE lassen sich anwendungsspezifische Vision-AI-Modelle in Minuten statt Monaten erzeugen und direkt auf kostengünstiger Edge-Hardware einsetzen. Dadurch werden auch Anwendungen wirtschaftlich, die bisher an Entwicklungsaufwand oder Hardwarekosten gescheitert sind.\n\nWenn Sie möchten, können wir an einem Datensatz kostenlos zeigen, was unsere Software in Ihrem Anwendungsfall leisten kann.\n\nWäre ein kurzer Austausch sinnvoll?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInMessage:
      "Kurze Frage: Gibt es bei Ihnen aktuell Qualitätskontroll- oder Prozessautomations-Themen, bei denen Vision-AI technisch sinnvoll wäre, bisher aber zu teuer oder zu aufwendig war? Genau dort setzen wir mit ONE WARE an.",
    phoneScript:
      "Hallo Herr/Frau [Name], [Ihr Name] von ONE WARE. Ganz kurz: Wir helfen Industrie-Teams dabei, Vision-AI für Qualitätskontrolle und Prozessautomation deutlich schneller und günstiger produktionsreif zu machen. Gibt es bei Ihnen aktuell solche Themen?"
  },
  camera_manufacturer_partner_template: {
    key: "camera_manufacturer_partner_template",
    audience: "Camera or imaging manufacturers that can offer AI-ready customer setups",
    goal: "Position ONE WARE as the software layer to enable AI-capable camera deployments for customers.",
    subject: "Vision-AI einfacher in Kamera- und Imaging-Lösungen integrieren",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nViele Kamera- und Imaging-Hersteller sehen Vision-AI als starkes Differenzierungsmerkmal, aber die durchgängige Modell- und Hardware-Optimierung kostet intern häufig zu viel Zeit.\n\nMit ONE WARE entstehen aus Daten in wenigen Minuten produktionsreife Vision-AI-Modelle, optimiert für die jeweilige Zielhardware.\n\nDamit können Sie Ihren Kunden AI-fähige Vorrichtungen und Lösungen deutlich schneller anbieten.\n\nWäre ein kurzer Austausch interessant, um potenzielle Partner-Use-Cases zu prüfen?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInMessage:
      "Kurze Frage: Wie aufwendig ist es bei Ihnen aktuell, Vision-AI kundenseitig produktionsreif in Imaging-Setups zu integrieren? Genau diesen Teil automatisieren wir.",
    phoneScript:
      "Hallo Herr/Frau [Name], [Ihr Name] von ONE WARE. Wir helfen Imaging-Herstellern, Vision-AI deutlich schneller in kundenfähige Lösungen zu bringen. Ist das bei Ihnen ein Thema?"
  },
  machine_builder_ai_enablement_template: {
    key: "machine_builder_ai_enablement_template",
    audience: "Machine builders that want to offer AI options or AI-ready fixtures to customers",
    goal: "Position ONE WARE as an AI enablement layer for machine builders without long model-development cycles.",
    subject: "Vision-AI einfacher in Maschinen und Produkte integrieren",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nViele Maschinenbauer und Hardwareanbieter sehen Vision-AI als spannendes Feature, aber die Entwicklung einer belastbaren, hardware-optimierten Lösung kostet intern oft zu viel Zeit.\n\nWir haben dafür mit ONE WARE einen Ansatz entwickelt, bei dem aus Daten in wenigen Minuten produktionsreife Vision-AI-Modelle entstehen, optimiert für die jeweilige Zielhardware. So lässt sich Vision-AI deutlich einfacher und günstiger in bestehende Produkte integrieren.\n\nWäre ein kurzer Austausch interessant, um zu prüfen, wo das bei Ihnen produktseitig relevant sein könnte?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInMessage:
      "Wie aufwendig ist es für Sie aktuell, Vision-AI produktionsreif in Maschinen oder Hardware zu integrieren? Wir sehen oft, dass gerade Modellwahl und Hardware-Optimierung den größten Aufwand erzeugen. Genau das automatisieren wir.",
    phoneScript:
      "Hallo Herr/Frau [Name], [Ihr Name] von ONE WARE. Ich halte es kurz: Wir helfen Maschinenbau- und Hardware-Teams, Vision-AI deutlich einfacher in Produkte zu integrieren, weil Modellgenerierung und Hardware-Optimierung weitgehend automatisiert werden. Ist das bei Ihnen ein aktuelles Thema?"
  },
  software_platform_embedding_template: {
    key: "software_platform_embedding_template",
    audience: "Software platforms that can embed ONE WARE as model-generation alternative (e.g. Roboflow-like)",
    goal: "Position ONE WARE as embeddable model-generation backend for platform providers.",
    subject: "Embeddable Vision-AI Modell-Engine für Ihre Plattform",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nWenn Ihre Plattform Vision-AI-Workflows für Kunden bereitstellt, ist die Modellgenerierung oft der zeitintensivste Teil.\n\nONE WARE kann hier als alternative Modell-Engine eingebettet werden: aus Daten in Minuten zu produktionsreifen, hardware-optimierten Modellen.\n\nDas ermöglicht zusätzliche Leistungsfähigkeit für Ihre Nutzer, ohne eigene langwierige Modell-Iterationen.\n\nWäre ein kurzer technischer Austausch sinnvoll, um Integrationsoptionen zu prüfen?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInMessage:
      "Kurze Frage: Prüfen Sie aktuell Optionen, wie Ihre Nutzer schneller zu produktionsreifen Vision-Modellen kommen? Wir liefern genau diesen Schritt als embeddable Engine.",
    phoneScript:
      "Hallo Herr/Frau [Name], [Ihr Name] von ONE WARE. Wir unterstützen Plattformanbieter dabei, Vision-Modellgenerierung als embeddable Layer anzubieten. Ist das bei Ihnen ein aktuelles Thema?"
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
  integrator_general_ai: {
    category: "integrator_general_ai",
    label: "Integrators with general AI focus",
    classificationRules: [
      "Relevant when the company clearly delivers AI projects or software implementations but is not strongly Vision-AI-specific yet.",
      "There should be evidence for project execution, implementation ownership, or customer-specific delivery rather than advisory-only positioning.",
      "Use this bucket when Vision AI is plausible but not explicit, and the company still looks like a real delivery partner."
    ],
    disqualifiers: ["AI consulting without implementation", "Generic SaaS AI features without project delivery", "Thought leadership or training-only AI firms"]
  },
  integrator_relevant_focus: {
    category: "integrator_relevant_focus",
    label: "Integrators with relevant vertical focus",
    classificationRules: [
      "Relevant when the company delivers projects in surveillance, defence, medtech vision, robotics, drones, agriculture tech, automotive tech, or industrial automation.",
      "The vertical should make camera, inspection, perception, tracking, or edge-AI use cases plausible from the company description.",
      "Delivery ownership still matters; do not use this bucket for pure component vendors or research organizations."
    ],
    disqualifiers: ["No project-delivery signals", "Irrelevant vertical without vision or automation tie-in", "Pure R&D lab with no commercial delivery path"]
  },
  industrial_end_customer_scaled: {
    category: "industrial_end_customer_scaled",
    label: "Scaled industrial end customers",
    classificationRules: [
      "Relevant when the company runs its own manufacturing, production lines, plants, or industrial operations at meaningful scale.",
      "Look for evidence of quality control, inspection, defect detection, process automation, packaging, assembly, or engineering-led operations.",
      "Engineering ownership, factory footprint, multi-site production, or industrial equipment references strengthen relevance."
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
      "Relevant when the company builds machines, OEM systems, manufacturing equipment, production cells, or industrial fixtures that could gain from embedded Vision AI.",
      "Look for OEM, Sondermaschinenbau, industrial equipment, packaging, assembly, inspection stations, or production-line language.",
      "Relevance is strongest when the company could offer AI as an option, module, retrofit, or performance upgrade to customers."
    ],
    disqualifiers: ["Pure distributor without machine-building capability", "Component seller with no system integration ownership", "No visible OEM or industrial equipment context"]
  },
  software_platform_embedding: {
    category: "software_platform_embedding",
    label: "Software platforms for embedding",
    classificationRules: [
      "Relevant when the company operates a software platform, workflow product, or developer-facing environment that could embed model-generation capabilities.",
      "A credible integration path should be visible through APIs, extensions, workflow automation, platform modules, or customer-configurable tooling.",
      "Use this only when there is real product surface for embedding, not just service delivery."
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
    classificationRules: ["Use when evidence is too weak or mixed for a strong category assignment."],
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
    researchPriorities: ["Validate OEM integration pathways and customer-facing AI option potential."],
    outreachPriorities: ["Position ONE WARE as fast AI enablement layer for machine offerings."],
    personalizationRules: ["Use machine/product context, not generic AI language."],
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