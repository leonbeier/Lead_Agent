import { ApolloOrganizationFilter } from "./types";

export const defaultApolloFilters: ApolloOrganizationFilter[] = [
  {
    name: "Germany Industrial Software Integrators",
    persona: "Software integrator with delivery ownership in industrial automation or embedded projects",
    industries: ["Industrial Automation", "System Integration", "Industrial Software", "Machinery"],
    keywords: ["system integrator", "industrial automation", "embedded systems", "inspection systems", "robotics"],
    locations: ["Germany"],
    employeeRanges: ["11,50", "51,200", "201,500", "501,1000"],
    notes: "Primary ICP. Prefer delivery-oriented service providers over generic consultancies or AI product vendors."
  },
  {
    name: "Germany AI Delivery Integrators",
    persona: "Software integrator that mentions AI or computer vision but mainly sells services and project delivery",
    industries: ["Industrial Automation", "Computer Vision", "Robotics", "Embedded Software"],
    keywords: ["computer vision", "image processing", "industrial ai", "embedded ai", "automation software"],
    locations: ["Germany"],
    employeeRanges: ["11,50", "51,200", "201,500"],
    notes: "Use only if the company behaves like a service provider. Deprioritize firms selling their own dominant AI integration platform."
  },
  {
    name: "Germany Industrial Customers With QC Need",
    persona: "Industrial company with internal engineering and likely QC, inspection, or process automation use cases",
    industries: ["Food Production", "Machinery", "Industrial Automation", "Automotive", "Electrical Manufacturing"],
    keywords: ["quality control", "visual inspection", "process automation", "production line", "machine vision"],
    locations: ["Germany"],
    employeeRanges: ["51,200", "201,500", "501,1000", "1001,5000"],
    notes: "Primary ICP. Prefer firms large enough for own development teams and visible production or inspection workflows."
  },
  {
    name: "Germany Machine Builders With Vision Upside",
    persona: "Machine builder or OEM that can embed Vision AI into products but is not already strongly positioned around its own Vision AI software",
    industries: ["Machinery", "Industrial Automation", "Electrical Manufacturing", "Robotics"],
    keywords: ["special machinery", "robotics", "inspection systems", "automation equipment", "oem machine"],
    locations: ["Germany"],
    employeeRanges: ["51,200", "201,500", "501,1000"],
    notes: "Secondary ICP. Good when hardware is strong but the own AI software layer is weak or absent."
  },
  {
    name: "Europe Industrial Camera Partners",
    persona: "Industrial imaging or camera vendor without a clear own Vision AI software commercialization angle",
    industries: ["Industrial Automation", "Electrical Manufacturing", "Hardware"],
    keywords: ["industrial camera", "machine vision", "imaging", "inspection camera", "embedded vision"],
    locations: ["Germany", "Netherlands", "Switzerland", "Austria"],
    employeeRanges: ["11,50", "51,200", "201,500"],
    notes: "Secondary partner search. Avoid companies whose main growth story is selling their own competing Vision AI software stack."
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