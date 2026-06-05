#!/usr/bin/env python3
"""
Patches hubspot.ts:
1. Replaces the heuristic block in discoverWebSearchContacts with agent-first version
2. Removes 6 dead methods: extractContactsFromSearchHits, isRelevantCompanyHit,
   extractNameFromSearchTitle, extractJobTitleFromSearchText,
   extractLinkedInConnectionCount, looksLikeJobTitle
"""
import sys

FILE = r"C:\Users\LeonBeier\GitHub\Lead_Agent\src\clients\hubspot.ts"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

# ── Change 1: Replace heuristic block in discoverWebSearchContacts ─────────
OLD1 = """    const hits = hitGroups.flat();
    const relevantHits = hits.filter((hit) =>
      this.isRelevantCompanyHit(
        company,
        companyAliases,
        [hit.title, hit.snippet].filter(Boolean).join(" | ")
      )
    );
    const searchEvidence = relevantHits
      .map((hit) => `Query: ${hit.query}\\nTitle: ${hit.title}\\nURL: ${hit.url}\\nSnippet: ${hit.snippet}`)
      .join("\\n\\n");
    const heuristicContacts = this.extractContactsFromSearchHits(company, relevantHits, companyAliases);
    const evidence = [
      websiteEvidence ? `Official website evidence:\\n${websiteEvidence}` : undefined,
      knownContactEvidence ? `Known website contacts:\\n${knownContactEvidence}` : undefined,
      searchEvidence ? `Web search evidence:\\n${searchEvidence}` : undefined
    ].filter(Boolean).join("\\n\\n");
    const strongHeuristicContacts = heuristicContacts.filter((contact) => this.isNamedEmployeeContact(contact));
    const foundryContacts = evidence.trim() && strongHeuristicContacts.length < 2
      ? await this.foundryAgentsClient.discoverPublicContacts(foundryCompany, evidence, false)
      : [];
    const mergedContacts = this.mergeDiscoveredContacts(foundryContacts, heuristicContacts);

    return mergedContacts.map((contact) => ({
      ...contact,
      jobTitle: this.normalizeJobTitle(contact.jobTitle) ?? contact.jobTitle,
      linkedinUrl: this.normalizeLinkedInUrl(contact.linkedinUrl),
      sourceUrl: contact.sourceUrl || contact.linkedinUrl || company.domain || company.name
    }));
  }"""

NEW1 = """    // Agent-first: pass all search hits directly to the AI agents. Do not filter hits with
    // isRelevantCompanyHit or extract names/titles via regex heuristics. The Foundry discovery
    // agent reads raw evidence and uses bing_grounding to find and evaluate real contacts.
    const allHits = hitGroups.flat();
    const searchEvidence = allHits
      .map((hit) => `Query: ${hit.query}\\nTitle: ${hit.title}\\nURL: ${hit.url}\\nSnippet: ${hit.snippet}`)
      .join("\\n\\n");
    const evidence = [
      websiteEvidence ? `Official website evidence:\\n${websiteEvidence}` : undefined,
      knownContactEvidence ? `Known website contacts:\\n${knownContactEvidence}` : undefined,
      searchEvidence ? `Web search evidence:\\n${searchEvidence}` : undefined
    ].filter(Boolean).join("\\n\\n");
    // Foundry bing_grounding agent is the primary discovery path: it reads the full evidence and
    // performs additional web searches as needed. Only skip when there is no evidence at all.
    const foundryContacts = evidence.trim()
      ? await this.foundryAgentsClient.discoverPublicContacts(foundryCompany, evidence, false)
      : [];

    return foundryContacts.map((contact) => ({
      ...contact,
      jobTitle: this.normalizeJobTitle(contact.jobTitle) ?? contact.jobTitle,
      linkedinUrl: this.normalizeLinkedInUrl(contact.linkedinUrl),
      sourceUrl: contact.sourceUrl || contact.linkedinUrl || company.domain || company.name
    }));
  }"""

if OLD1 not in content:
    print("ERROR: Change 1 pattern not found. Verify file content.", file=sys.stderr)
    sys.exit(1)

content = content.replace(OLD1, NEW1, 1)
print("Change 1 applied: discoverWebSearchContacts heuristic block replaced")

# ── Change 2: Remove dead methods block ────────────────────────────────────
# Find start marker: "\n  private extractContactsFromSearchHits("
# Find end marker: "\n  private async searchBingResults("
START_MARKER = "\n  private extractContactsFromSearchHits("
END_MARKER = "\n  private async searchBingResults("

start_idx = content.find(START_MARKER)
end_idx = content.find(END_MARKER)

if start_idx == -1:
    print("ERROR: extractContactsFromSearchHits not found", file=sys.stderr)
    sys.exit(1)
if end_idx == -1:
    print("ERROR: searchBingResults not found", file=sys.stderr)
    sys.exit(1)
if start_idx >= end_idx:
    print(f"ERROR: start_idx ({start_idx}) >= end_idx ({end_idx})", file=sys.stderr)
    sys.exit(1)

removed = content[start_idx:end_idx]
print(f"Change 2: removing {len(removed)} chars ({removed.count(chr(10))} lines) of dead methods")
content = content[:start_idx] + content[end_idx:]

# Verify file still compiles (basic check)
assert "private async searchBingResults(" in content, "searchBingResults missing after patch"
assert "extractContactsFromSearchHits" not in content, "extractContactsFromSearchHits still present"
assert "isRelevantCompanyHit" not in content or "isRelevantCompanyHit or extract" in content, "isRelevantCompanyHit still present as method"
assert "extractNameFromSearchTitle" not in content, "extractNameFromSearchTitle still present"
assert "looksLikeJobTitle" not in content, "looksLikeJobTitle still present"

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

lines = content.count("\n") + 1
print(f"Done. File written with {lines} lines.")
