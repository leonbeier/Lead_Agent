import { ApolloOrganizationFilter } from "./types";

export const defaultApolloFilters: ApolloOrganizationFilter[] = [
  {
    name: "DACH Vision / Industrial AI Integrators",
    persona: "Software integrator with explicit machine-vision or industrial-AI delivery ownership",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Embedded Software"],
    keywords: ["system integrator", "industrial automation", "machine vision integration", "inspection systems", "embedded software"],
    locations: ["Germany", "Austria", "Switzerland"],
    employeeRanges: ["11,50", "51,200", "201,500", "501,1000"],
    targetCategories: ["integrator_vision_industrial_ai"],
    notes: "Primary ICP. Prefer delivery-oriented teams with recurring vision-heavy projects."
  },
  {
    name: "DACH General AI Integrators",
    persona: "Software or consulting integrator with general AI focus and real implementation ownership",
    industries: ["Industrial Automation", "Computer Vision", "Embedded Software", "Industrial Software"],
    keywords: ["computer vision integration", "image processing", "industrial ai", "automation software", "engineering services"],
    locations: ["Germany", "Austria", "Switzerland"],
    employeeRanges: ["11,50", "51,200", "201,500"],
    targetCategories: ["integrator_general_ai"],
    notes: "Use when AI capability is visible, even if vision specialization is not explicit yet."
  },
  {
    name: "Europe Relevant-Vertical Integrators",
    persona: "Integrator active in relevant verticals like surveillance, defence, medtech, robotics, drones, agriculture, automotive",
    industries: ["Industrial Automation", "Aerospace", "Medical Devices", "Automotive", "Industrial Software"],
    keywords: ["surveillance integration", "defence systems integration", "medtech imaging", "industrial inspection", "automotive vision"],
    locations: ["Germany", "Netherlands", "France", "Belgium", "Sweden"],
    employeeRanges: ["11,50", "51,200", "201,500", "501,1000"],
    targetCategories: ["integrator_relevant_focus"],
    notes: "Focus on vertical specialists where vision and edge constraints are recurring delivery bottlenecks."
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