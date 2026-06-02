import { defaultFilters } from "../filters";
import { OrganizationFilter, SelectableLeadCategory } from "../types";

const REGION_ALIASES: Record<string, string> = {
  DE: "Germany",
  D: "Germany",
  DEU: "Germany",
  AT: "Austria",
  AUT: "Austria",
  CH: "Switzerland",
  CHE: "Switzerland",
  EU: "Europe",
  EUR: "Europe",
  DACH: "DACH"
};

export type DebugConsoleSearchMode = "exa_search" | "diffbot_search";

export interface DebugConsoleRequestInput {
  targetCategory: SelectableLeadCategory;
  region?: string;
  companySearchMode: DebugConsoleSearchMode;
  limit: number;
  websites?: string[];
}

export function buildDebugSearchFilter(
  targetCategory: SelectableLeadCategory,
  region?: string,
  filters: OrganizationFilter[] = defaultFilters
): OrganizationFilter {
  const categoryMatches = filters.filter((filter) => filter.targetCategories?.includes(targetCategory));
  if (categoryMatches.length === 0) {
    throw new Error(`No default filter exists for category ${targetCategory}.`);
  }

  const normalizedRegion = normalizeRegion(region);
  const normalizedRegionToken = normalizedRegion?.toLowerCase();
  const exactRegionMatch = normalizedRegionToken
    ? categoryMatches.find((filter) => filter.locations.some((location) => location.trim().toLowerCase() === normalizedRegionToken))
    : undefined;
  const partialRegionMatch = normalizedRegionToken
    ? categoryMatches.find((filter) => filter.locations.some((location) => location.trim().toLowerCase().includes(normalizedRegionToken)))
    : undefined;
  const baseFilter = exactRegionMatch ?? partialRegionMatch ?? categoryMatches[0];

  return {
    ...baseFilter,
    name: normalizedRegion ? `${baseFilter.name} [debug ${normalizedRegion}]` : `${baseFilter.name} [debug]`,
    locations: normalizedRegion ? [normalizedRegion] : [...baseFilter.locations],
    notes: `${baseFilter.notes} Debug console request for ${targetCategory}${normalizedRegion ? ` in ${normalizedRegion}` : ""}.`
  };
}

export function normalizeManualWebsites(websites?: string[]): string[] {
  if (!websites || websites.length === 0) {
    return [];
  }

  const normalized = new Set<string>();
  for (const website of websites) {
    const canonical = normalizeWebsiteUrl(website);
    if (canonical) {
      normalized.add(canonical);
    }
  }

  return [...normalized];
}

export function normalizeWebsiteUrl(value?: string): string | undefined {
  const trimmedValue = value?.trim();
  if (!trimmedValue) {
    return undefined;
  }

  const candidate = /^https?:\/\//i.test(trimmedValue) ? trimmedValue : `https://${trimmedValue}`;
  try {
    const url = new URL(candidate);
    if (!url.hostname) {
      return undefined;
    }

    url.hash = "";
    url.search = "";
    url.pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function normalizeRegion(region?: string): string | undefined {
  const trimmed = region?.trim();
  if (!trimmed) {
    return undefined;
  }

  const collapsed = trimmed.replace(/\s+/g, " ");
  return REGION_ALIASES[collapsed.toUpperCase()] ?? collapsed;
}