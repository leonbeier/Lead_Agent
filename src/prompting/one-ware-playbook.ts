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
  software_integrator_template: {
    key: "software_integrator_template",
    audience: "Software integrators and technical development service providers",
    goal: "Position ONE WARE as a multiplier for project delivery and margin, not as a generic AI vendor.",
    subject: "Vision-AI ohne lange Optimierungsphasen",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nArbeiten Sie aktuell an Vision-AI-Projekten, bei denen es viele Iterationen braucht, bis ein Modell einsatzbereit ist – oder es trotz mehrerer Versuche nicht zuverlässig funktioniert?\n\nGenau das sehen wir häufig bei Integratoren: Wochen bis Monate fließen in Tuning und Deployment, statt in die eigentliche Lösung.\n\nWir haben dafür eine Software entwickelt, mit der sich individuelle Vision-AI-Modelle in unter 5 Minuten erzeugen und direkt produktionsbereit einsetzen lassen. Dadurch können Teams deutlich schneller iterieren, Projektlaufzeiten besser planen und mit dem gleichen Team mehr Projekte umsetzen.\n\nMich würde interessieren: Wo liegt bei Ihnen aktuell der größte Engpass in Vision-AI-Projekten – eher in der Modellgenerierung oder in der Integration?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInMessage:
      "Kurze Frage: Wie schnell bekommen Sie aktuell ein Vision-AI-Modell produktionsbereit? Ich sehe bei Integratoren oft, dass Modellwahl und Optimierung unnötig viel Zeit kosten. Wir automatisieren genau diesen Teil. Wie ist das bei Ihnen aktuell?",
    phoneScript:
      "Hallo Herr/Frau [Name], [Ihr Name] von ONE WARE hier. Ich mache es kurz – passt es gerade für 30 Sekunden? Wir sprechen aktuell mit Integratoren, bei denen Modellwahl und Optimierung in Vision-AI-Projekten Wochen oder Monate kosten. Wir automatisieren genau diesen Teil. Wie ist das bei Ihnen aktuell?"
  },
  industrial_customer_template: {
    key: "industrial_customer_template",
    audience: "Industrial end customers with QC, inspection, or process automation use cases",
    goal: "Position ONE WARE as a faster and lower-cost route to production-ready Vision AI for real factory use cases.",
    subject: "Qualitätskontrolle und Vision-AI wirtschaftlicher umsetzen",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nBei vielen Industrieprojekten sehen wir, dass Vision-AI für Qualitätskontrolle oder Prozessautomation grundsätzlich sinnvoll wäre, die Umsetzung aber zu teuer, zu langsam oder technisch zu aufwendig wird.\n\nGenau dort setzen wir an: Mit ONE WARE lassen sich anwendungsspezifische Vision-AI-Modelle in Minuten statt Monaten erzeugen und direkt auf kostengünstiger Edge-Hardware einsetzen. Dadurch werden auch Anwendungen wirtschaftlich, die bisher an Entwicklungsaufwand oder Hardwarekosten gescheitert sind.\n\nWenn Sie möchten, können wir an einem Datensatz kostenlos zeigen, was unsere Software in Ihrem Anwendungsfall leisten kann.\n\nWäre ein kurzer Austausch sinnvoll?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInMessage:
      "Kurze Frage: Gibt es bei Ihnen aktuell Qualitätskontroll- oder Prozessautomations-Themen, bei denen Vision-AI technisch sinnvoll wäre, bisher aber zu teuer oder zu aufwendig war? Genau dort setzen wir mit ONE WARE an.",
    phoneScript:
      "Hallo Herr/Frau [Name], [Ihr Name] von ONE WARE. Ganz kurz: Wir helfen Industrie-Teams dabei, Vision-AI für Qualitätskontrolle und Prozessautomation deutlich schneller und günstiger produktionsreif zu machen. Gibt es bei Ihnen aktuell solche Themen?"
  },
  hardware_partner_template: {
    key: "hardware_partner_template",
    audience: "Machine builders and industrial hardware vendors without a strong own Vision AI software layer",
    goal: "Position ONE WARE as an embeddable software layer that upgrades hardware offerings without a large AI team.",
    subject: "Vision-AI einfacher in Maschinen und Produkte integrieren",
    emailBody:
      "Hallo Herr/Frau [Name],\n\nViele Maschinenbauer und Hardwareanbieter sehen Vision-AI als spannendes Feature, aber die Entwicklung einer belastbaren, hardware-optimierten Lösung kostet intern oft zu viel Zeit.\n\nWir haben dafür mit ONE WARE einen Ansatz entwickelt, bei dem aus Daten in wenigen Minuten produktionsreife Vision-AI-Modelle entstehen, optimiert für die jeweilige Zielhardware. So lässt sich Vision-AI deutlich einfacher und günstiger in bestehende Produkte integrieren.\n\nWäre ein kurzer Austausch interessant, um zu prüfen, wo das bei Ihnen produktseitig relevant sein könnte?\n\nMit freundlichen Grüßen\n[Ihr Name]",
    linkedInMessage:
      "Wie aufwendig ist es für Sie aktuell, Vision-AI produktionsreif in Maschinen oder Hardware zu integrieren? Wir sehen oft, dass gerade Modellwahl und Hardware-Optimierung den größten Aufwand erzeugen. Genau das automatisieren wir.",
    phoneScript:
      "Hallo Herr/Frau [Name], [Ihr Name] von ONE WARE. Ich halte es kurz: Wir helfen Maschinenbau- und Hardware-Teams, Vision-AI deutlich einfacher in Produkte zu integrieren, weil Modellgenerierung und Hardware-Optimierung weitgehend automatisiert werden. Ist das bei Ihnen ein aktuelles Thema?"
  }
};

export const CATEGORY_EXECUTION_CONTEXT: Record<LeadCategory, CategoryExecutionContext> = {
  software_integrator: {
    category: "software_integrator",
    label: "Delivery-led software integrator",
    researchPriorities: [
      "Verify the company builds and delivers customer-specific industrial, embedded, automation, robotics, defence, surveillance, medtech, or machine software projects.",
      "Check whether image, video, inspection, quality control, or edge deployment is likely to recur across projects.",
      "Prefer firms with delivery ownership, fixed-price pressure, and limited internal AI specialization."
    ],
    outreachPriorities: [
      "Lead with reduced trial and error, faster delivery, and better project margins.",
      "Frame ONE WARE as a multiplier for project throughput, not as a generic AI vendor.",
      "Connect to repeatable customer projects and time-to-delivery pressure."
    ],
    personalizationRules: [
      "Only personalize with a concrete service, industry project, or delivery signal from the website or recent activity.",
      "Keep the base outreach template structure and wording direction intact.",
      "If no strong hook exists, stay close to the standard software-integrator template."
    ],
    avoidSignals: [
      "Do not position ONE WARE as replacing the integrator's business.",
      "Avoid over-personalized compliments without a delivery-relevant fact.",
      "Avoid focusing first on APIs or hosting before the project-efficiency pain is established."
    ]
  },
  ai_software_integrator: {
    category: "ai_software_integrator",
    label: "AI-aware integrator without strong competing product layer",
    researchPriorities: [
      "Verify whether the company mainly delivers AI projects as a service rather than monetizing its own dominant AI integration platform.",
      "Look for clues that they already solve customer projects but still face iteration, deployment, or hardware-efficiency pain.",
      "Disqualify or heavily downgrade if they mainly sell their own competing Vision AI software stack."
    ],
    outreachPriorities: [
      "Acknowledge they already know AI and focus on delivery efficiency, model fit, and hardware optimization.",
      "Position ONE WARE as a way to increase throughput and reduce manual iteration in client delivery.",
      "Use partner-like language rather than basic AI education."
    ],
    personalizationRules: [
      "Personalize only around visible AI delivery focus, edge deployment, or real project references.",
      "Do not rewrite the message as if the target is AI-inexperienced.",
      "If the company appears too product-led and competitive, make the risk explicit instead of forcing outreach fit."
    ],
    avoidSignals: [
      "Avoid generic AI buzzwords without operational relevance.",
      "Avoid claims that imply they cannot build AI themselves.",
      "Avoid strong partnership framing if the company clearly looks like a direct software competitor."
    ]
  },
  machine_builder_with_vision_ai_need: {
    category: "machine_builder_with_vision_ai_need",
    label: "Industrial customer or machine builder with concrete use-case pressure",
    researchPriorities: [
      "Look for quality control, inspection, process automation, robotics, machine optimization, or hardware-product integration opportunities.",
      "Check whether the company is large enough to have internal engineering ownership and realistic deployment paths.",
      "Look for evidence that current solutions may be too expensive, too slow, or still technically limited."
    ],
    outreachPriorities: [
      "Lead with business and engineering impact: faster path to production-ready models, lower deployment cost, and new feasibility on cheaper hardware.",
      "Use the free-dataset-test angle when there is a clear QC or inspection hook.",
      "Highlight where previous attempts may have been too costly or not accurate enough."
    ],
    personalizationRules: [
      "Personalize around a concrete production, inspection, process, or product context only if clearly visible.",
      "Keep the outreach grounded in operational bottlenecks, not in generic innovation messaging.",
      "Where possible, connect the use case to cost, throughput, or deployment simplicity."
    ],
    avoidSignals: [
      "Avoid abstract AI transformation language.",
      "Avoid heavy partner framing if the company is more likely an end customer.",
      "Avoid feature lists without tying them to QC, automation, or product economics."
    ]
  },
  industrial_camera_vendor_without_ai_software: {
    category: "industrial_camera_vendor_without_ai_software",
    label: "Hardware or imaging partner without dominant AI software monetization",
    researchPriorities: [
      "Verify the company is strong in hardware, imaging, optics, or cameras but weak in its own commercial Vision AI software layer.",
      "Assess whether ONE WARE could complement the product stack rather than cannibalize an existing software business.",
      "Look for embedded, OEM, or partner-enablement signals."
    ],
    outreachPriorities: [
      "Lead with embeddable value: add Vision AI capability without building a large internal ML team.",
      "Focus on product enhancement, partner enablement, and hardware-fit.",
      "Use partner language carefully and only if the complementarity is plausible."
    ],
    personalizationRules: [
      "Personalize around camera, imaging, OEM, or inspection product lines only if a clear fit is visible.",
      "Do not personalize in a way that suggests replacing their core hardware business.",
      "If they clearly sell their own AI software stack, treat that as a risk flag."
    ],
    avoidSignals: [
      "Avoid targeting strong existing AI software commercialization as a positive signal.",
      "Avoid writing like they are a service integrator if they are clearly a hardware company.",
      "Avoid generic broad partner claims without product-stack evidence."
    ]
  },
  irrelevant: {
    category: "irrelevant",
    label: "Irrelevant or excluded profile",
    researchPriorities: [
      "Confirm why the company is out of scope and capture that reason clearly.",
      "Prefer explicit disqualification over speculative fit creation.",
      "Use geography, business model, and competitor status as primary exclusion reasons."
    ],
    outreachPriorities: [
      "Do not force outreach preparation when the company is a bad fit.",
      "Summarize the exclusion reason cleanly.",
      "Protect research time for stronger ICP candidates."
    ],
    personalizationRules: [
      "Do not personalize outreach for disqualified leads.",
      "Keep the summary concise and factual.",
      "Return the no-fit reason clearly."
    ],
    avoidSignals: [
      "Avoid optimistic interpretation of weak signals.",
      "Avoid creating templates or hooks where no fit exists.",
      "Avoid forcing a category upgrade without objective evidence."
    ]
  },
  other: {
    category: "other",
    label: "Mixed or unclear fit",
    researchPriorities: [
      "Resolve ambiguity by checking whether the company owns delivery, has repeatable vision-relevant projects, and fits target geographies.",
      "Look for concrete clues that justify moving the company into one of the primary ICP categories.",
      "If ambiguity remains, keep the score conservative."
    ],
    outreachPriorities: [
      "Only produce outreach if a concrete hook and plausible business fit exist.",
      "Keep the message conservative and template-led.",
      "Favor operational relevance over speculative strategic fit."
    ],
    personalizationRules: [
      "Personalize only when a specific application, delivery pattern, or product fit is visible.",
      "Do not overcommit on fit if the evidence is mixed.",
      "Use the most adjacent template and explain remaining uncertainty."
    ],
    avoidSignals: [
      "Avoid broad assumptions from weak website wording.",
      "Avoid strong competitive claims without evidence.",
      "Avoid treating vague AI interest as a sufficient buying trigger."
    ]
  }
};

export function getTemplateKeyForCategory(category: LeadCategory): string {
  switch (category) {
    case "software_integrator":
    case "ai_software_integrator":
      return "software_integrator_template";
    case "machine_builder_with_vision_ai_need":
      return "industrial_customer_template";
    case "industrial_camera_vendor_without_ai_software":
      return "hardware_partner_template";
    default:
      return "software_integrator_template";
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
    agentContext ? `Operator context from HubSpot or workflow:\n${agentContext}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}