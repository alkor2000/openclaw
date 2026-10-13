import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assessClaimFreshness,
  buildClaimContradictionClusters,
  buildPageContradictionClusters,
  normalizeClaimStatus,
  type WikiFreshnessLevel,
} from "./claim-health.js";
import type {
  MemoryWikiCompiledCacheSnapshot,
  MemoryWikiImportInsightItem,
  MemoryWikiOverviewItem,
} from "./compiled-cache.js";
import { buildMemoryWikiImportInsights } from "./import-insights.js";
import type { WikiClaim, WikiPageSummary } from "./markdown.js";
import { buildMemoryWikiOverview } from "./wiki-overview.js";

const FRESHNESS_RANK: Record<WikiFreshnessLevel, number> = {
  fresh: 3,
  aging: 2,
  stale: 1,
  unknown: 0,
};

function sortClaims(page: WikiPageSummary): WikiClaim[] {
  return page.claims.toSorted((left, right) => {
    const leftConfidence = left.confidence ?? -1;
    const rightConfidence = right.confidence ?? -1;
    if (leftConfidence !== rightConfidence) {
      return rightConfidence - leftConfidence;
    }
    const leftFreshness = FRESHNESS_RANK[assessClaimFreshness({ page, claim: left }).level];
    const rightFreshness = FRESHNESS_RANK[assessClaimFreshness({ page, claim: right }).level];
    if (leftFreshness !== rightFreshness) {
      return rightFreshness - leftFreshness;
    }
    return left.text.localeCompare(right.text);
  });
}

export function buildCompiledCacheSnapshot(scan: {
  pages: WikiPageSummary[];
  importInsights: MemoryWikiImportInsightItem[];
  overviewItems: MemoryWikiOverviewItem[];
}): MemoryWikiCompiledCacheSnapshot {
  const pagesInput = scan.pages;
  const pages = pagesInput
    .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((page) => {
      const digestPage: Omit<
        MemoryWikiCompiledCacheSnapshot["digest"]["pages"][number],
        "claimCount" | "topClaims"
      > = Object.assign(page.id ? { id: page.id } : {}, {
        title: page.title,
        kind: page.kind,
        path: page.relativePath,
        aliases: [...page.aliases],
        sourceIds: [...page.sourceIds],
        questions: [...page.questions],
        contradictions: [...page.contradictions],
        bestUsedFor: [...page.bestUsedFor],
        notEnoughFor: [...page.notEnoughFor],
        relationshipCount: page.relationships.length,
        topRelationships: page.relationships.slice(0, 5),
      });
      if (page.pageType) {
        digestPage.pageType = page.pageType;
      }
      if (page.entityType) {
        digestPage.entityType = page.entityType;
      }
      if (page.canonicalId) {
        digestPage.canonicalId = page.canonicalId;
      }
      if (page.privacyTier) {
        digestPage.privacyTier = page.privacyTier;
      }
      if (page.personCard) {
        digestPage.personCard = page.personCard;
      }
      return Object.assign(digestPage, {
        claimCount: page.claims.length,
        topClaims: sortClaims(page)
          .slice(0, 5)
          .map((claim) =>
            Object.assign(
              claim.id ? { id: claim.id } : {},
              { text: claim.text, status: normalizeClaimStatus(claim.status) },
              typeof claim.confidence === "number" ? { confidence: claim.confidence } : {},
              { freshnessLevel: assessClaimFreshness({ page, claim }).level },
            ),
          ),
      });
    });
  const claims = pagesInput
    .flatMap((page) =>
      sortClaims(page).map((claim) => {
        const freshness = assessClaimFreshness({ page, claim });
        return Object.assign(claim.id ? { id: claim.id } : {}, {
          pageId: page.id,
          pageTitle: page.title,
          pageKind: page.kind,
          pagePath: page.relativePath,
          pageType: page.pageType,
          entityType: page.entityType,
          canonicalId: page.canonicalId,
          aliases: page.aliases,
          text: claim.text,
          status: normalizeClaimStatus(claim.status),
          confidence: claim.confidence,
          sourceIds: page.sourceIds,
          evidenceKinds: uniqueStrings(claim.evidence.flatMap((entry) => entry.kind ?? [])),
          privacyTiers: [
            ...new Set(
              [
                page.privacyTier,
                page.personCard?.privacyTier,
                ...claim.evidence.map((entry) => entry.privacyTier),
              ].flatMap((entry) => entry ?? []),
            ),
          ],
          freshnessLevel: freshness.level,
          lastTouchedAt: freshness.lastTouchedAt,
        });
      }),
    )
    .toSorted(
      (left, right) =>
        left.pagePath.localeCompare(right.pagePath) || left.text.localeCompare(right.text),
    );
  return {
    digest: {
      claimCount: claims.length,
      contradictionCount:
        buildPageContradictionClusters(pagesInput).length +
        buildClaimContradictionClusters({ pages: pagesInput }).length,
      pages,
    },
    claims,
    dashboards: {
      importInsights: buildMemoryWikiImportInsights(scan.importInsights),
      overview: buildMemoryWikiOverview(scan.pages, scan.overviewItems),
    },
  };
}
