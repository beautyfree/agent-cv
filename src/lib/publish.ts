import type { Inventory, Project } from "./types.ts";

/**
 * Sanitize inventory for publishing — strip private data, format for API.
 */
export function sanitizeForPublish(
  inventory: Inventory,
  bioOverride?: string
) {
  const { profile, insights } = inventory;
  const projects = inventory.projects.filter((p) => p.included !== false).map((p: Project) => {
    const isPublic = p.isPublic ?? false;
    return {
      id: p.id, displayName: p.displayName, type: p.type, language: p.language,
      frameworks: p.frameworks, dateRange: p.dateRange, hasGit: p.hasGit,
      commitCount: p.commitCount, authorCommitCount: p.authorCommitCount,
      hasUncommittedChanges: p.hasUncommittedChanges,
      lastCommit: p.lastCommit,
      analysis: p.analysis,
      tags: p.tags, included: true,
      remoteUrl: isPublic ? p.remoteUrl : null,
      stars: p.stars || undefined,
      isPublic,
      isOwner: p.isOwner,
      significance: p.significance,
      tier: p.tier,
    };
  });
  // Build socialLinks in the format the web API expects (full URLs)
  const socialLinks: Record<string, string> = {};
  if (profile.socials?.github) socialLinks.github = `https://github.com/${profile.socials.github}`;
  if (profile.socials?.twitter) socialLinks.twitter = `https://twitter.com/${profile.socials.twitter}`;
  if (profile.socials?.linkedin) socialLinks.linkedin = `https://linkedin.com/in/${profile.socials.linkedin}`;
  if (profile.socials?.telegram) socialLinks.telegram = `https://t.me/${profile.socials.telegram}`;
  if (profile.socials?.website) socialLinks.website = profile.socials.website;
  if (profile.emailPublic && profile.emails?.[0]) socialLinks.email = profile.emails[0];

  return {
    inventory: { version: inventory.version, projects },
    bio: bioOverride || insights.bio,
    socialLinks: Object.keys(socialLinks).length > 0 ? socialLinks : undefined,
    name: profile.name,
    highlightsByYear: insights.highlightsByYear,
    narrative: insights.narrative,
    strongestSkills: insights.strongestSkills,
    uniqueTraits: insights.uniqueTraits,
    yearlyThemes: insights.yearlyThemes,
    yearlyInsights: insights.yearlyInsights,
  };
}
