$file = "C:\Users\LeonBeier\GitHub\Lead_Agent\src\clients\hubspot.ts"
$lines = Get-Content $file
$total = $lines.Length
Write-Host "Total lines: $total"

# Change 1: Replace lines 1572-1601 (0-indexed 1571-1600) in discoverWebSearchContacts
# with agent-first version. Line 1572 starts with "    const hits = hitGroups.flat();"
# Line 1601 is "  }" — closing brace of discoverWebSearchContacts.

$replacement1 = @(
    "    // Agent-first: pass all search hits directly to the AI agents. Do not filter hits with",
    "    // isRelevantCompanyHit or extract names/titles via regex heuristics. The Foundry discovery",
    "    // agent reads raw evidence and uses bing_grounding to find and evaluate real contacts.",
    "    const allHits = hitGroups.flat();",
    "    const searchEvidence = allHits",
    '      .map((hit) => `Query: ${hit.query}\nTitle: ${hit.title}\nURL: ${hit.url}\nSnippet: ${hit.snippet}`)',
    '      .join("\n\n");',
    "    const evidence = [",
    '      websiteEvidence ? `Official website evidence:\n${websiteEvidence}` : undefined,',
    '      knownContactEvidence ? `Known website contacts:\n${knownContactEvidence}` : undefined,',
    '      searchEvidence ? `Web search evidence:\n${searchEvidence}` : undefined',
    '    ].filter(Boolean).join("\n\n");',
    "    // Foundry bing_grounding agent is the primary discovery path: it reads the full evidence and",
    "    // performs additional web searches as needed. Only skip when there is no evidence at all.",
    "    const foundryContacts = evidence.trim()",
    "      ? await this.foundryAgentsClient.discoverPublicContacts(foundryCompany, evidence, false)",
    "      : [];",
    "",
    "    return foundryContacts.map((contact) => ({",
    "      ...contact,",
    "      jobTitle: this.normalizeJobTitle(contact.jobTitle) ?? contact.jobTitle,",
    "      linkedinUrl: this.normalizeLinkedInUrl(contact.linkedinUrl),",
    "      sourceUrl: contact.sourceUrl || contact.linkedinUrl || company.domain || company.name",
    "    }));",
    "  }"
)

# Verify the lines we're replacing
Write-Host "Replacing lines 1572-1601:"
Write-Host "  Start: $($lines[1571])"
Write-Host "  End:   $($lines[1600])"

# Verify dead methods block: lines 1806-1989 (0-indexed 1805-1988)
Write-Host "Removing dead methods lines 1806-1989:"
Write-Host "  Start: $($lines[1805])"
Write-Host "  End:   $($lines[1988])"

# Build new lines array
$before1 = $lines[0..1570]           # lines 1-1571 (0-indexed 0..1570)
$after1 = $lines[1601..($total-1)]   # lines 1602-end (0-indexed 1601..)

$part1 = $before1 + $replacement1 + $after1
Write-Host "After change 1: $($part1.Length) lines"

# Recalculate line numbers after change 1
# original 1806 -> new index = 1806 - 1 - (1601 - 1571 - $replacement1.Length)
# original lines 1806-1989 had 184 lines (1989-1806+1=184)
# these are now at new indices: 
$removedInChange1 = (1601 - 1571)  # = 30 lines removed
$addedInChange1 = $replacement1.Length  # = 25 lines added
$delta1 = $addedInChange1 - $removedInChange1
Write-Host "Delta from change 1: $delta1"
$newStart = 1805 + $delta1  # new 0-indexed start of dead methods block
$newEnd = 1988 + $delta1    # new 0-indexed end of dead methods block
Write-Host "Dead methods now at new 0-indexed range: $newStart - $newEnd"
Write-Host "  Start: $($part1[$newStart])"
Write-Host "  End:   $($part1[$newEnd])"

# Change 2: Remove lines $newStart through $newEnd
$before2 = $part1[0..($newStart-1)]
$after2 = $part1[($newEnd+1)..($part1.Length-1)]
$result = $before2 + $after2
Write-Host "Final line count: $($result.Length)"

# Write the result
[System.IO.File]::WriteAllLines($file, $result, [System.Text.UTF8Encoding]::new($false))
Write-Host "Done. File written."
