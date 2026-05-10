import { env, readiness } from "../config";
import { PreCategorizedCompany, ResearchBrief } from "../types";

export class HubSpotClient {
  async syncQualifiedCompanies(
    companies: PreCategorizedCompany[],
    researchBriefs: ResearchBrief[],
    dryRun: boolean
  ): Promise<{ mode: "dry-run" | "live"; attempted: boolean; candidateCount: number; syncedCount: number }> {
    if (dryRun || !readiness.hubspotConfigured) {
      return {
        mode: "dry-run",
        attempted: false,
        candidateCount: companies.length,
        syncedCount: 0
      };
    }

    for (const company of companies) {
      const brief = researchBriefs.find((item) => item.companyName === company.name);
      await fetch(`${env.HUBSPOT_BASE_URL}/crm/v3/objects/companies`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.HUBSPOT_PRIVATE_APP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          properties: {
            name: company.name,
            domain: company.domain,
            country: company.country,
            description: company.shortDescription,
            lead_category: company.category,
            lead_relevance_score: String(company.relevanceScore),
            lead_rationale: company.rationale,
            outreach_linkedin_angle: brief?.linkedInAngle,
            outreach_email_angle: brief?.emailAngle,
            outreach_phone_angle: brief?.phoneAngle,
            outreach_event_idea: brief?.eventIdea
          }
        })
      });
    }

    return {
      mode: "live",
      attempted: true,
      candidateCount: companies.length,
      syncedCount: companies.length
    };
  }
}