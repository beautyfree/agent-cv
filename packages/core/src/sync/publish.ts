import type { Inventory, Project } from "../types.ts";
import { getSyncClient } from "./client.ts";
import { getCurrentUserId, LOCAL_USER_ID, promoteLocalUserId } from "./user.ts";

/**
 * Tombstone all of the user's portfolio rows, then push to the server so
 * the public page goes blank. Replaces the old `unpublishPortfolio` tRPC call.
 */
export async function unpublishViaSync(): Promise<void> {
  const userId = await getCurrentUserId();
  if (userId === LOCAL_USER_ID) {
    throw new Error("Not authenticated — nothing to unpublish.");
  }

  const client = await getSyncClient();

  const projects = (await client
    .model("project")
    .findMany({ userId })) as Array<{ id: string }>;
  for (const p of projects) {
    await client.model("project").delete(p.id);
  }

  const profile = await client.model("profile").findOne({ userId });
  if (profile) {
    await client.model("profile").delete(userId);
  }

  const override = await client.model("override").findOne({ userId });
  if (override) {
    await client.model("override").delete(userId);
  }

  await client.syncNow();
}

/**
 * Publish an inventory via bettersync.
 *
 * Maps the local Inventory into `project`/`profile` rows, upserts them into the
 * local PGlite store, then triggers `syncNow()` to push to the server.
 *
 * Returns the authenticated username and the public profile URL.
 */
export async function publishViaSync(
  inventory: Inventory,
  opts: { apiBaseUrl?: string } = {}
): Promise<{ url: string; username: string }> {
  const userId = await getCurrentUserId();
  if (userId === LOCAL_USER_ID) {
    throw new Error(
      "Cannot publish anonymously — run `agent-cv login` first."
    );
  }

  await promoteLocalUserId(userId);
  const client = await getSyncClient();

  // Projects: filter to included, non-removed.
  const projects = inventory.projects.filter(
    (p) => p.included !== false && !p.tags.includes("removed")
  );

  for (const p of projects) {
    await upsertProject(client, userId, p);
  }

  await upsertProfile(client, userId, inventory);

  await client.syncNow();

  const base = (
    opts.apiBaseUrl ??
    process.env.AGENT_CV_API_URL ??
    "https://agent-cv.dev"
  ).replace(/\/$/, "");

  return { url: `${base}/${userId}`, username: userId };
}

async function upsertProject(
  client: Awaited<ReturnType<typeof getSyncClient>>,
  userId: string,
  p: Project
): Promise<void> {
  const isPublic = p.isPublic ?? false;
  const row: Record<string, unknown> = {
    id: p.id,
    userId,
    path: p.path,
    displayName: p.displayName,
    suggestedName: p.suggestedName,
    type: p.type,
    language: p.language,
    frameworks: p.frameworks ?? [],
    markers: p.markers ?? [],
    dateRange: p.dateRange,
    size: p.size,
    hasGit: p.hasGit,
    commitCount: p.commitCount,
    authorCommitCount: p.authorCommitCount,
    hasUncommittedChanges: p.hasUncommittedChanges,
    lastCommit: p.lastCommit,
    description: p.description,
    topics: p.topics,
    license: p.license,
    analysis: p.analysis,
    tags: p.tags ?? [],
    included: p.included ?? true,
    remoteUrl: isPublic ? p.remoteUrl : undefined,
    isPublic,
    stars: p.stars,
    significance: p.significance,
    tier: p.tier,
    projectGroup: p.projectGroup,
    isOwner: p.isOwner,
    isFork: p.isFork,
    githubParentFullName: isPublic ? p.githubParentFullName : undefined,
    upstreamPrCount: p.upstreamPrCount,
    source: p.source,
  };

  const existing = await client.model("project").findOne({ id: p.id });
  if (existing) {
    await client.model("project").update(p.id, row);
  } else {
    await client.model("project").insert(row);
  }
}

async function upsertProfile(
  client: Awaited<ReturnType<typeof getSyncClient>>,
  userId: string,
  inv: Inventory
): Promise<void> {
  const { profile, insights, githubExtras, publishedPackages } = inv;
  const socialsOut: Record<string, string> = {};
  if (profile.socials?.github)
    socialsOut.github = `https://github.com/${profile.socials.github}`;
  if (profile.socials?.twitter)
    socialsOut.twitter = `https://twitter.com/${profile.socials.twitter}`;
  if (profile.socials?.linkedin)
    socialsOut.linkedin = `https://linkedin.com/in/${profile.socials.linkedin}`;
  if (profile.socials?.telegram)
    socialsOut.telegram = `https://t.me/${profile.socials.telegram}`;
  if (profile.socials?.website) socialsOut.website = profile.socials.website;
  if (profile.emailPublic && profile.emails?.[0])
    socialsOut.email = profile.emails[0];

  const row: Record<string, unknown> = {
    userId,
    name: profile.name,
    emailPublic: profile.emailPublic,
    contactEmail: profile.emailPublic ? profile.emails?.[0] : undefined,
    socials: Object.keys(socialsOut).length ? socialsOut : undefined,
    avatarUrl: githubExtras?.avatarUrl,
    bio: insights.bio,
    narrative: insights.narrative,
    strongestSkills: insights.strongestSkills,
    uniqueTraits: insights.uniqueTraits,
    highlights: insights.highlights,
    highlightsByYear: insights.highlightsByYear,
    yearlyThemes: insights.yearlyThemes,
    yearlyInsights: insights.yearlyInsights,
    githubExtras,
    publishedPackages,
  };

  const existing = await client.model("profile").findOne({ userId });
  if (existing) {
    await client.model("profile").update(userId, row);
  } else {
    await client.model("profile").insert(row);
  }
}
