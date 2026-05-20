export const OPTIMIZED_VISION_INTEGRATOR_SEARCH_CONTEXT = [
  "You are steering a Europe-first search for ONE WARE focused on delivery-led machine vision, visual inspection, and industrial automation integrators.",
  "Use normal web research plus direct company-site crawling. Prefer official company websites and internal pages such as About, Services, Solutions, Applications, Industries, References, Case Studies, Support, and Contact.",
  "Primary target countries: Germany, France, Italy, Netherlands, Switzerland, Sweden, Austria, Spain.",
  "Require a real company homepage and prefer firms whose main presence clearly sits in one of the target countries instead of generic global directories or marketplace profiles.",
  "Strong positive vision signals: machine vision, industrial vision, visual inspection, optical inspection, automated optical inspection, quality inspection, vision-guided robotics, industrielle Bildverarbeitung, optische Inspektion.",
  "Require delivery ownership as a second independent signal: system integrator, system integration, turnkey, custom solution, customer-specific, engineering services, commissioning, robot guidance, inspection system, automation solution, inspection solutions, quality control, implementation, project, Systemintegration, kundenspezifisch, Automatisierungstechnik, Sondermaschinenbau.",
  "Prefer firms with evidence of consulting, planning, development, integration, commissioning, optimization, support, references, case studies, and customer-specific implementation.",
  "Deprioritize or exclude weak-fit profiles such as face recognition, face tracking, biometrics, virtual try-on, security, smart city, traffic enforcement, marketing research, camera modules, smart cameras, embedded vision platforms, LED lighting, x-ray inspection, distributors, resellers, photonics, fiber optics, hardness testing, materialographic systems, metering pumps, electronics manufacturing services, contract manufacturing, and PCB assembly.",
  "Be cautious with camera/component manufacturers, OEM product vendors, sensor vendors, embedded-vision vendors, and platform companies unless delivery ownership for customer-specific industrial inspection projects is explicit.",
  "Treat the search like a two-part filter: keep firms only when both the machine-vision signal and the implementation/integration signal are present somewhere across company descriptions, site copy, services, industries, references, or case studies.",
  "At the end of each probe and expansion batch, compare good vs bad firms and tighten minimally: keep working positive search clusters, add small negative constraints for repeated bad patterns, and avoid broad rewrites that would drop already-good integrators."
].join("\n\n");

export type SearchStrategyPreset = "default" | "optimized_vision_integrators";

export function resolveSearchStrategyPresetContext(preset: SearchStrategyPreset | undefined): string | undefined {
  if (preset === "optimized_vision_integrators") {
    return OPTIMIZED_VISION_INTEGRATOR_SEARCH_CONTEXT;
  }

  return undefined;
}