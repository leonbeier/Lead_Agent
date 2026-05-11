import { LeadCategory } from "../types";

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
  "venture capital",
  "private equity",
  "bank",
  "financial services",
  "generic consultancy",
  "reseller",
  "china",
  "saudi arabia"
];

export const ONE_WARE_PROMPT_CONTEXT = `
You represent ONE WARE GmbH.

Core positioning:
- ONE WARE sells software that automatically creates production-ready Physical AI, Vision AI, and Edge AI models in minutes instead of months.
- The core business value is less trial and error, faster delivery, more predictable project timelines, smaller and more efficient models, lower development costs, local training options, open API access, and vendor-independent deployment.
- Focus on real delivery problems, not generic AI enthusiasm.

Primary ICP focus:
1. Software integrators that visibly offer Vision AI, Industrial AI, or embedded AI services.
2. Software integrators with AI messaging, especially where they deliver projects instead of selling a packaged AI platform.
3. Software integrators working on industrial automation, robotics, surveillance, defence, medtech vision, drones, agriculture, or automotive systems.
4. Industrial companies with clear internal use cases like quality control, inspection, process automation, and enough scale for their own engineering team.

Secondary focus:
- Machine builders or hardware vendors that can embed ONE WARE into their products.
- Partners without a strong competing own Vision AI software layer.

Deprioritize or disqualify:
- VC, PE, banks, generic finance, broad consulting without delivery ownership.
- Companies outside Germany as first focus unless there is a very strong fit in EU, US, Japan, or Korea.
- Companies that mainly sell their own competing Vision AI software stack.
- Companies that are strong AI platform competitors rather than integrators or delivery partners.

Messaging rules:
- Do not rewrite outreach from scratch every time.
- Start from the segment template and personalize only where there is a clear factual hook.
- Keep ONE WARE's USP visible: less trial and error, faster delivery, more predictable projects, local training, smaller hardware-efficient models, lower development effort.
- Personalization should point to a concrete delivery bottleneck, use case, or market signal, not generic flattery.
`;

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
      "Classify here when services explicitly mention Vision AI, machine vision, industrial AI delivery, inspection AI, or edge vision deployment.",
      "Delivery ownership and project implementation should be visible."
    ],
    disqualifiers: ["Pure product vendors without delivery ownership", "Direct competing own vision platform as primary business"]
  },
  integrator_general_ai: {
    category: "integrator_general_ai",
    label: "Integrators with general AI focus",
    classificationRules: [
      "Classify here when company is clearly AI-service-led but not strongly vision-specific.",
      "Projects and implementation ownership should be visible."
    ],
    disqualifiers: ["AI consulting without implementation", "Generic SaaS AI features without delivery services"]
  },
  integrator_relevant_focus: {
    category: "integrator_relevant_focus",
    label: "Integrators with relevant vertical focus",
    classificationRules: [
      "Classify here for integrators in surveillance, defence, medtech vision, robotics, drones, agriculture tech, automotive tech, industrial automation.",
      "Vision/edge potential should be plausible from project signals."
    ],
    disqualifiers: ["No project-delivery signals", "Irrelevant vertical without vision/automation tie-in"]
  },
  industrial_end_customer_scaled: {
    category: "industrial_end_customer_scaled",
    label: "Scaled industrial end customers",
    classificationRules: [
      "Classify here when company has own production and sufficient scale for lucrative QC/inspection/process-automation projects.",
      "Evidence for engineering ownership is preferred."
    ],
    disqualifiers: ["Small workshops/manufactories without engineering capacity", "No internal production context"]
  },
  camera_manufacturer_partner: {
    category: "camera_manufacturer_partner",
    label: "Camera manufacturers as partners",
    classificationRules: [
      "Classify here when company is camera/imaging hardware manufacturer that can offer AI-capable setups to customers.",
      "Partner fit should be stronger than direct competition risk."
    ],
    disqualifiers: ["Strong own competing vision software monetization"]
  },
  machine_builder_ai_enablement: {
    category: "machine_builder_ai_enablement",
    label: "Machine builders for AI enablement",
    classificationRules: [
      "Classify here when machine builder can offer AI options, fixtures, or integration pathways for customers.",
      "OEM/industrial equipment context should be visible."
    ],
    disqualifiers: ["Pure distributor without machine integration capability"]
  },
  software_platform_embedding: {
    category: "software_platform_embedding",
    label: "Software platforms for embedding",
    classificationRules: [
      "Classify here when software platform can embed model-generation capabilities for users.",
      "Platform integration path should be plausible."
    ],
    disqualifiers: ["No extensibility/integration path", "Direct platform competitor with no partner incentive"]
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

export function buildExecutionContextBlock(category: LeadCategory, agentContext?: string): string {
  const context = getExecutionContextForCategory(category);

  return [
    `Category context: ${context.label}`,
    "Research priorities:",
    ...context.researchPriorities.map((item) => `- ${item}`),
    "Outreach priorities:",
    ...context.outreachPriorities.map((item) => `- ${item}`),
    "Personalization rules:",
    ...context.personalizationRules.map((item) => `- ${item}`),
    "Avoid signals:",
    ...context.avoidSignals.map((item) => `- ${item}`),
    agentContext ? `Category-specific operator context:\n${agentContext}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildPrequalificationContextBlock(agentContext?: string): string {
  const categoryRules = Object.values(CATEGORY_PREQUALIFICATION_CONTEXT)
    .map((context) => {
      return [
        `Category: ${context.category} (${context.label})`,
        ...context.classificationRules.map((rule) => `- Rule: ${rule}`),
        ...context.disqualifiers.map((rule) => `- Disqualifier: ${rule}`)
      ].join("\n");
    })
    .join("\n\n");

  return [
    "Prequalification categories:",
    categoryRules,
    agentContext ? `Prequalification operator context:\n${agentContext}` : undefined
  ]
    .filter(Boolean)
    .join("\n\n");
}