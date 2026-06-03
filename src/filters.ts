import { OrganizationFilter } from "./types";

const GERMANY_COUNTRY_TOKENS = new Set([
  "de",
  "deutschland",
  "germany"
]);

const GERMANY_CITY_TOKENS = new Set([
  "berlin",
  "hamburg",
  "munich",
  "muenchen",
  "münchen",
  "cologne",
  "koln",
  "köln",
  "frankfurt",
  "stuttgart",
  "dusseldorf",
  "düsseldorf",
  "leipzig",
  "dresden",
  "hannover",
  "bremen",
  "essen",
  "dortmund",
  "nuremberg",
  "nuernberg",
  "nürnberg"
]);

const GERMANY_MARKET_TOKENS = new Set([...GERMANY_COUNTRY_TOKENS, ...GERMANY_CITY_TOKENS]);

const MARKET_NOISE_TOKENS = new Set([
  "market",
  "markt",
  "region",
  "area",
  "raum",
  "focus",
  "fokus",
  "city",
  "stadt"
]);

function tokenizeMarket(value?: string): string[] {
  return (value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function isGermanyFocusedMarket(market?: string): boolean {
  return tokenizeMarket(market).some((token) => GERMANY_MARKET_TOKENS.has(token));
}

export function extractExplicitMarketLocality(market?: string): string | undefined {
  const trimmedMarket = market?.trim();
  if (!trimmedMarket) {
    return undefined;
  }

  const prefixMatch = trimmedMarket.match(/^(?:de|germany|deutschland)[\s,\/\-|]+(.+)$/i);
  const suffixMatch = trimmedMarket.match(/^(.+?)[\s,\/\-|]+(?:de|germany|deutschland)$/i);
  const candidate = prefixMatch?.[1] ?? suffixMatch?.[1];
  if (!candidate) {
    return undefined;
  }

  const normalizedTokens = candidate
    .split(/[^a-z0-9äöüß]+/i)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !GERMANY_COUNTRY_TOKENS.has(token.toLowerCase()))
    .filter((token) => !MARKET_NOISE_TOKENS.has(token.toLowerCase()));

  if (normalizedTokens.length === 0) {
    return undefined;
  }

  return normalizedTokens
    .slice(0, 3)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function applyExplicitMarketLocality(filter: OrganizationFilter, market?: string): OrganizationFilter {
  const locality = extractExplicitMarketLocality(market);
  if (!locality || !isGermanyFocusedMarket(market)) {
    return filter;
  }

  return {
    ...filter,
    locations: Array.from(new Set([`${locality}, Germany`, ...filter.locations])),
    notes: `${filter.notes} Explicit local focus: ${locality}, Germany.`
  };
}

export function filterSupportsMarketScope(filter: OrganizationFilter, market?: string): boolean {
  if (!isGermanyFocusedMarket(market)) {
    return true;
  }

  return filter.locations.every((location) => location.trim().toLowerCase() === "germany");
}

export const defaultFilters: OrganizationFilter[] = [
  {
    name: "Europe Vision System Integrators",
    persona: "European system integrator delivering machine vision inspection, optical inspection, and industrial image processing projects for customers",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Machinery"],
    keywords: [
      "machine vision integrator",
      "industrial vision integrator",
      "visual inspection integrator",
      "optical inspection system integrator",
      "industrial image processing",
      "quality inspection automation",
      "system integration machine vision",
      "industrielle bildverarbeitung"
    ],
    locations: ["Germany", "France", "Italy", "Netherlands", "Belgium", "Switzerland", "Sweden", "Austria", "Spain", "Denmark", "Portugal", "Poland", "Czech Republic"],
    employeeRanges: ["11,50", "51,200", "201,500", "501,1000"],
    targetCategories: ["integrator_vision_industrial_ai"],
    notes: "Europe-wide ICP. Target delivery-oriented machine-vision and inspection integrators with explicit customer project ownership across the selected countries."
  },
  {
    name: "Europe Industrial Automation Integration Partners",
    persona: "European industrial automation and software integration partner delivering PLC, SCADA, MES, OT, and customer-specific implementation projects for manufacturers",
    industries: ["Industrial Automation", "Industrial Software", "System Integration", "Machinery"],
    keywords: [
      "industrial automation integrator",
      "plc scada mes integration",
      "ot integration",
      "manufacturing software implementation",
      "systemintegration automation",
      "production software engineering",
      "industrial digitalization",
      "customer-specific automation projects"
    ],
    locations: ["Europe"],
    employeeRanges: ["11,50", "51,200", "201,500", "501,1000"],
    targetCategories: ["integrator_relevant_focus"],
    notes: "Europe-wide discovery for delivery-led industrial automation, OT, and production software implementation partners. Prefer project businesses with customer integration ownership over broad AI consultancies or product-only vendors."
  },
  {
    name: "Europe Industrial Inspection Engineering Firms",
    persona: "European engineering and software service provider delivering AOI, inline inspection, industrial image processing, or computer vision projects for industrial customers",
    industries: ["Industrial Automation", "Industrial Software", "System Integration", "Electronics"],
    keywords: [
      "automated optical inspection",
      "aoi integrator",
      "inline inspection",
      "industrial image processing",
      "optische inspektion",
      "quality inspection engineering",
      "computer vision engineering services",
      "inspection system integrator"
    ],
    locations: ["Germany", "France", "Italy", "Netherlands", "Belgium", "Switzerland", "Sweden", "Austria", "Spain", "Denmark", "Portugal", "Poland", "Czech Republic"],
    employeeRanges: ["11,50", "51,200", "201,500"],
    targetCategories: ["integrator_vision_industrial_ai", "integrator_relevant_focus"],
    notes: "Europe-wide inspection and industrial computer-vision delivery partners. Prefer firms closer to AOI, inline inspection, and industrial project delivery than broad AI vendors."
  },
  {
    name: "Benelux DACH Vision Integration Specialists",
    persona: "System integrator or engineering specialist in DACH and Benelux delivering machine vision, industrial inspection, and customer-specific automation projects",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Electronics"],
    keywords: [
      "machine vision integration",
      "vision-guided robotics",
      "inspection solutions",
      "customer-specific automation",
      "turnkey inspection systems",
      "robot guidance",
      "kundenspezifisch bildverarbeitung",
      "systemintegration vision"
    ],
    locations: ["Germany", "Netherlands", "Belgium", "Switzerland", "Austria"],
    employeeRanges: ["11,50", "51,200", "201,500"],
    targetCategories: ["integrator_vision_industrial_ai"],
    notes: "Targets DACH plus Netherlands specialists with delivery-led automation and inspection ownership, not distributors or component vendors."
  },
  {
    name: "France Italy Spain Vision Inspection Integrators",
    persona: "Southern European industrial automation or system integration company delivering machine vision, quality inspection, or optical inspection projects for customers",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Machinery"],
    keywords: [
      "machine vision integrator",
      "visual inspection automation",
      "optical inspection systems",
      "quality control integration",
      "engineering services inspection",
      "turnkey machine vision",
      "industrial vision projects",
      "inspection automation solution"
    ],
    locations: ["France", "Italy", "Spain"],
    employeeRanges: ["11,50", "51,200", "201,500", "501,1000"],
    targetCategories: ["integrator_vision_industrial_ai"],
    notes: "Broaden into Southern Europe while keeping explicit inspection and project-delivery ownership. Exclude security-only or component-led firms."
  },
  {
    name: "France Vision Industrielle Integrateurs",
    persona: "French industrial vision integrator delivering vision industrielle, controle qualite, inspection optique, and customer-specific automation projects",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Machinery"],
    keywords: [
      "vision industrielle",
      "integrateur vision",
      "controle qualite",
      "inspection optique",
      "inspection visuelle",
      "systeme de vision industrielle",
      "automatisation controle qualite",
      "deep learning industriel"
    ],
    locations: ["France"],
    employeeRanges: ["1,10", "11,50", "51,200", "201,500"],
    targetCategories: ["integrator_vision_industrial_ai"],
    notes: "French-language discovery for explicit industrial vision and inspection integrators with project delivery ownership."
  },
  {
    name: "Italy Visione Industriale Integratori",
    persona: "Italian system integrator or engineering company delivering visione industriale, optical inspection, and quality control projects for industrial customers",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Machinery"],
    keywords: [
      "visione industriale",
      "integratore sistemi visione",
      "ispezione ottica",
      "controllo qualita",
      "visione artificiale industriale",
      "sistemi di visione",
      "automazione controllo qualita",
      "integrazione machine vision"
    ],
    locations: ["Italy"],
    employeeRanges: ["1,10", "11,50", "51,200", "201,500"],
    targetCategories: ["integrator_vision_industrial_ai"],
    notes: "Italian-language search for delivery-led industrial vision and inspection specialists with customer implementation ownership."
  },
  {
    name: "Spain Vision Industrial Integradores",
    persona: "Spanish industrial automation or systems integration firm delivering vision artificial industrial, inspeccion optica, and quality control projects",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Machinery"],
    keywords: [
      "vision artificial industrial",
      "integrador vision artificial",
      "inspeccion optica",
      "control de calidad vision",
      "sistemas de vision artificial",
      "automatizacion inspeccion",
      "integrador de sistemas industriales",
      "inspeccion visual automatizada"
    ],
    locations: ["Spain"],
    employeeRanges: ["1,10", "11,50", "51,200", "201,500"],
    targetCategories: ["integrator_vision_industrial_ai"],
    notes: "Spanish-language discovery for industrial vision and quality-inspection integrators with real delivery ownership."
  },
  {
    name: "Netherlands Sweden Vision Automation Integrators",
    persona: "Dutch, Belgian, or Swedish industrial automation partner delivering machine vision, optical inspection, or quality-control implementation projects for customers",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Electronics"],
    keywords: [
      "machine vision integrator",
      "optical inspection automation",
      "quality inspection systems",
      "vision-guided robotics",
      "industrial image processing",
      "inspection solution provider",
      "automation engineering services",
      "customer-specific inspection"
    ],
    locations: ["Netherlands", "Belgium", "Sweden"],
    employeeRanges: ["1,10", "11,50", "51,200", "201,500"],
    targetCategories: ["integrator_vision_industrial_ai"],
    notes: "Focused Northern Europe discovery for machine-vision and inspection implementation partners with engineering ownership, including Belgian integrators that often appear in Benelux search results."
  },
  {
    name: "Austria Switzerland Vision Inspection Integrators",
    persona: "Austrian or Swiss system integrator delivering machine vision, optical inspection, inline inspection, and customer-specific automation solutions for industrial customers",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Machinery"],
    keywords: [
      "machine vision integrator",
      "optische inspektion",
      "inline inspection",
      "qualitaetskontrolle automation",
      "industrielle bildverarbeitung",
      "systemintegration vision",
      "kundenspezifische pruefsysteme",
      "automatisierung bildverarbeitung"
    ],
    locations: ["Austria", "Switzerland"],
    employeeRanges: ["1,10", "11,50", "51,200", "201,500"],
    targetCategories: ["integrator_vision_industrial_ai"],
    notes: "Focused AT/CH discovery for delivery-led industrial vision and inspection integrators with project ownership."
  },
  {
    name: "Germany Machine Vision System Integrators",
    persona: "German system integrator delivering machine vision inspection and industrial image processing projects for customers",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Machinery"],
    keywords: [
      "machine vision integrator",
      "industrielle bildverarbeitung",
      "bildverarbeitungssysteme",
      "industrial image processing",
      "inspection systems",
      "quality inspection",
      "system integrator",
      "machbarkeitsanalyse bildverarbeitung"
    ],
    locations: ["Germany"],
    employeeRanges: ["11,50", "51,200", "201,500", "501,1000"],
    targetCategories: ["integrator_vision_industrial_ai"],
    notes: "Primary ICP. Target delivery-oriented German machine-vision and inspection integrators with customer project ownership."
  },
  {
    name: "Germany Vision AI Consulting Specialists",
    persona: "German consulting firm or boutique engineering specialist delivering machine vision, industrial AI, AOI, or embedded vision implementation work for industrial customers",
    industries: ["Industrial Automation", "Industrial Software", "Computer Vision", "Embedded Software"],
    keywords: [
      "machine vision consultant",
      "bildverarbeitung beratung",
      "industrial ai consulting",
      "aoi beratung",
      "embedded vision consultant",
      "industrial image processing consulting",
      "inspection ai consultant"
    ],
    locations: ["Germany"],
    employeeRanges: ["1,10", "11,50"],
    targetCategories: ["integrator_vision_ai_consulting"],
    notes: "Find German consulting firms and very small specialist boutiques with explicit machine-vision, AOI, industrial AI, or embedded vision delivery ownership for industrial customers. Exclude freelancers, generic strategy consultancies, and training-only profiles."
  },
  {
    name: "Germany Vision AI Freelance Specialists",
    persona: "German freelancer or solo engineering specialist delivering machine vision, industrial AI, AOI, or embedded vision implementation work for industrial customers",
    industries: ["Industrial Automation", "Industrial Software", "Computer Vision", "Embedded Software"],
    keywords: [
      "computer vision freelancer",
      "vision ai freelancer",
      "machine vision freelancer",
      "bildverarbeitung freelancer",
      "industrial ai freelancer",
      "embedded vision freelancer",
      "inspection ai freelancer"
    ],
    locations: ["Germany"],
    employeeRanges: ["1,10"],
    targetCategories: ["integrator_vision_ai_freelancer"],
    notes: "Find German freelancers and solo specialists with explicit machine-vision, AOI, industrial AI, or embedded vision delivery ownership for industrial customers. Exclude consulting firms, agencies, generic strategy consultancies, and training-only profiles."
  },
  {
    name: "Germany Automation Software Integrators",
    persona: "German automation software integrator delivering MES, SCADA, PLC, and industrial software projects with customer implementation ownership",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Machinery"],
    keywords: [
      "industrial automation integrator",
      "automatisierung software dienstleister",
      "sondermaschinen software",
      "mes system integrator",
      "scada system integrator",
      "plc software integration",
      "industrial software services",
      "manufacturing software implementation",
      "ot integration",
      "softwareentwicklung industrie"
    ],
    locations: ["Germany"],
    employeeRanges: ["11,50", "51,200", "201,500", "501,1000"],
    targetCategories: ["integrator_general_ai"],
    notes: "German industrial software and automation implementation partners with clear delivery ownership. Prefer project-led OT, PLC, SCADA, and MES services over generic SaaS or HR software vendors."
  },
  {
    name: "Germany Embedded Vision Engineering Firms",
    persona: "German embedded software and computer vision engineering services company serving industrial customers",
    industries: ["Embedded Software", "Industrial Automation", "Electronics", "Industrial Software"],
    keywords: [
      "embedded software services",
      "embedded vision engineering",
      "embedded software dienstleister",
      "computer vision engineering services",
      "bildverarbeitung dienstleistungen",
      "industrial imaging integration",
      "edge ai integration",
      "industrial software engineering",
      "softwareentwicklung support"
    ],
    locations: ["Germany"],
    employeeRanges: ["11,50", "51,200", "201,500"],
    targetCategories: ["integrator_relevant_focus", "integrator_general_ai"],
    notes: "German engineering service providers with embedded, edge, or computer-vision delivery capability for industrial customers. Prefer service-led development and integration teams over product-only robotics or model-platform vendors."
  },
  {
    name: "Germany Industrial Computer Vision Engineering Services",
    persona: "German engineering and software service provider delivering machine vision, AOI, inline inspection, or embedded computer vision projects for industrial customers",
    industries: ["Industrial Automation", "Industrial Software", "System Integration", "Electronics"],
    keywords: [
      "automated optical inspection",
      "aoi integrator",
      "inline inspection",
      "optische qualitaetskontrolle",
      "industrial image processing",
      "computer vision engineering services",
      "machine vision integration",
      "optical quality control",
      "embedded computer vision",
      "beratung projektbewertung bildverarbeitung"
    ],
    locations: ["Germany"],
    employeeRanges: ["11,50", "51,200", "201,500"],
    targetCategories: ["integrator_vision_industrial_ai", "integrator_relevant_focus"],
    notes: "Targets project-driven firms with AOI, inline inspection, and industrial computer vision delivery rather than broad AI vendors."
  },
  {
    name: "Germany Smart Factory Software Engineering Partners",
    persona: "German software engineering partner implementing smart factory, MES, production data, or industrial digitalization solutions for manufacturers",
    industries: ["Industrial Software", "Industrial Automation", "System Integration", "Machinery"],
    keywords: [
      "smart factory software",
      "smart factory dienstleister",
      "industrial software engineering",
      "manufacturing software implementation",
      "production data integration",
      "ot integration",
      "industrial digitalization",
      "smart systems engineering",
      "co engineering automation",
      "produktionssoftware dienstleister"
    ],
    locations: ["Germany"],
    employeeRanges: ["11,50", "51,200", "201,500", "501,1000"],
    targetCategories: ["integrator_general_ai", "integrator_relevant_focus"],
    notes: "Targets project-driven software delivery partners for production and smart factory environments, not generic SaaS vendors."
  },
  {
    name: "DACH Industrial Software Integration Partners",
    persona: "DACH industrial software and automation integration partner delivering MES, SCADA, PLC, production data, and OT implementation projects for manufacturers",
    industries: ["Industrial Software", "Industrial Automation", "System Integration", "Machinery"],
    keywords: [
      "mes system integrator",
      "scada system integrator",
      "produktionssoftware dienstleister",
      "automatisierung software dienstleister",
      "ot integration",
      "plc software integration",
      "industrial digitalization",
      "softwareentwicklung industrie",
      "systemintegration automation",
      "prozessleittechnik integration"
    ],
    locations: ["Germany", "Austria", "Switzerland"],
    employeeRanges: ["11,50", "51,200", "201,500", "501,1000"],
    targetCategories: ["integrator_general_ai", "integrator_relevant_focus"],
    notes: "Expands software-led discovery beyond Germany-only filters toward DACH implementation partners with explicit MES, SCADA, PLC, OT, and production software delivery ownership."
  },
  {
    name: "DACH Scaled Industrial End Customers",
    persona: "Industrial end customer with own production scale and likely QC/process-automation upside",
    industries: ["Food Production", "Consumer Goods", "Pharma Manufacturing", "Automotive Manufacturing", "Electrical Manufacturing"],
    keywords: ["quality control", "visual inspection", "process automation", "production line", "machine vision"],
    locations: ["Germany", "Austria", "Switzerland"],
    employeeRanges: ["201,500", "501,1000", "1001,5000", "5001,10000"],
    targetCategories: ["industrial_end_customer_scaled"],
    notes: "Prefer companies with visible production engineering ownership and enough scale for high-value projects. Target factory operators and manufacturers that buy and run production equipment, not machine builders, OEMs, or automation vendors."
  },
  {
    name: "Europe Camera Manufacturers",
    persona: "Industrial imaging or camera manufacturer that can partner on AI-ready customer offerings",
    industries: ["Industrial Automation", "Electrical Manufacturing", "Hardware"],
    keywords: ["industrial camera", "machine vision", "imaging", "inspection camera", "embedded vision"],
    locations: ["Germany", "Netherlands", "Switzerland", "Austria", "France"],
    employeeRanges: ["11,50", "51,200", "201,500"],
    targetCategories: ["camera_manufacturer_partner"],
    notes: "Partner search. Deprioritize manufacturers monetizing a strong competing AI software stack."
  },
  {
    name: "DACH Machine Builders For AI Options",
    persona: "Machine builder or OEM that can offer AI options, fixtures, or AI-ready integrations to customers",
    industries: ["Machinery", "Industrial Automation", "Electrical Manufacturing", "Robotics"],
    keywords: ["special machinery", "oem", "inspection systems", "automation equipment", "production machines"],
    locations: ["Germany", "Austria", "Switzerland"],
    employeeRanges: ["51,200", "201,500", "501,1000", "1001,5000"],
    targetCategories: ["machine_builder_ai_enablement"],
    notes: "Prefer builders with modular products and clear customer integration pathways."
  },
  {
    name: "Europe Software Platforms For Embedding",
    persona: "Software platform where model generation can be embedded as capability layer",
    industries: ["Computer Software", "Developer Tools", "Industrial Software", "Cloud Services"],
    keywords: ["platform", "api", "workflow", "annotation", "model deployment", "computer vision platform"],
    locations: ["Germany", "Netherlands", "France", "UK", "Sweden"],
    employeeRanges: ["11,50", "51,200", "201,500", "501,1000"],
    targetCategories: ["software_platform_embedding"],
    notes: "Seek extensible platforms where ONE WARE can be integrated as model-generation backend."
  }
];

export function buildSuggestedFilters(market?: string, customGoal?: string): OrganizationFilter[] {
  return defaultFilters.map((filter) => ({
    ...filter,
    notes: [filter.notes, market ? `Market focus: ${market}.` : undefined, customGoal ? `Custom goal: ${customGoal}.` : undefined]
      .filter(Boolean)
      .join(" ")
  }))
    .filter((filter) => filterSupportsMarketScope(filter, market))
    .map((filter) => applyExplicitMarketLocality(filter, market));
}