import { ApolloOrganizationFilter } from "./types";

export const defaultApolloFilters: ApolloOrganizationFilter[] = [
  {
    name: "Germany Machine Vision System Integrators",
    persona: "German system integrator delivering machine vision inspection and industrial image processing projects for customers",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Machinery"],
    keywords: ["machine vision integrator", "industrial image processing", "inspection systems", "quality inspection", "system integrator"],
    locations: ["Germany"],
    employeeRanges: ["11,50", "51,200", "201,500", "501,1000"],
    targetCategories: ["integrator_vision_industrial_ai"],
    notes: "Primary ICP. Target delivery-oriented German machine-vision and inspection integrators with customer project ownership."
  },
  {
    name: "Germany Automation Software Integrators",
    persona: "German automation software integrator delivering MES, SCADA, PLC, and industrial software projects with customer implementation ownership",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Information Technology and Services"],
    keywords: ["automation software", "mes integration", "scada integration", "industrial software", "system integrator"],
    locations: ["Germany"],
    employeeRanges: ["11,50", "51,200", "201,500", "501,1000"],
    targetCategories: ["integrator_general_ai"],
    notes: "German industrial software and automation implementation partners with clear delivery ownership."
  },
  {
    name: "Germany Embedded Vision Engineering Firms",
    persona: "German embedded software and computer vision engineering services company serving industrial customers",
    industries: ["Embedded Software", "Industrial Automation", "Computer Vision", "Electronics"],
    keywords: ["embedded vision", "computer vision engineering", "embedded software services", "industrial ai", "edge ai"],
    locations: ["Germany"],
    employeeRanges: ["11,50", "51,200", "201,500"],
    targetCategories: ["integrator_relevant_focus", "integrator_general_ai"],
    notes: "German engineering service providers with embedded, edge, or computer-vision delivery capability for industrial customers."
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