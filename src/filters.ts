import { ApolloOrganizationFilter } from "./types";

export const defaultApolloFilters: ApolloOrganizationFilter[] = [
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
    notes: "Targets firms closer to OCTUM or VEO-style customer project delivery in AOI, inline inspection, and industrial computer vision rather than broad AI vendors."
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
    notes: "Targets Lachmann & Rink or Germanedge-like project-driven software delivery partners for production and smart factory environments, not generic SaaS vendors."
  },
  {
    name: "DACH Scaled Industrial End Customers",
    persona: "Industrial end customer with own production scale and likely QC/process-automation upside",
    industries: ["Food Production", "Machinery", "Industrial Automation", "Automotive", "Electrical Manufacturing"],
    keywords: ["quality control", "visual inspection", "process automation", "production line", "machine vision"],
    locations: ["Germany", "Austria", "Switzerland"],
    employeeRanges: ["201,500", "501,1000", "1001,5000", "5001,10000"],
    targetCategories: ["industrial_end_customer_scaled"],
    notes: "Prefer companies with visible production engineering ownership and enough scale for high-value projects."
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

export function buildSuggestedFilters(market?: string, customGoal?: string): ApolloOrganizationFilter[] {
  return defaultApolloFilters.map((filter) => ({
    ...filter,
    notes: [filter.notes, market ? `Market focus: ${market}.` : undefined, customGoal ? `Custom goal: ${customGoal}.` : undefined]
      .filter(Boolean)
      .join(" ")
  }));
}