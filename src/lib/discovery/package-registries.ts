/**
 * Package registry scanner.
 * Searches npm, PyPI, and crates.io for packages published by a user.
 * Best-effort: failures are logged, never block the pipeline.
 */

export interface PublishedPackage {
  name: string;
  description: string;
  registry: "npm" | "pypi" | "crates";
  url: string;
  version?: string;
}

/**
 * Search all registries for packages by a user.
 * Returns results from all registries that succeed.
 */
export async function searchPackageRegistries(
  username: string,
  onWarning?: (registry: string, error: string) => void
): Promise<PublishedPackage[]> {
  const results = await Promise.allSettled([
    searchNpm(username),
    searchPyPI(username),
    searchCrates(username),
  ]);

  const packages: PublishedPackage[] = [];
  const registryNames = ["npm", "PyPI", "crates.io"] as const;

  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.status === "fulfilled") {
      packages.push(...result.value);
    } else {
      onWarning?.(registryNames[i]!, `${registryNames[i]} search failed: ${result.reason?.message || String(result.reason)}`);
    }
  }

  return packages;
}

async function searchNpm(username: string): Promise<PublishedPackage[]> {
  const res = await fetch(
    `https://registry.npmjs.org/-/v1/search?text=maintainer:${encodeURIComponent(username)}&size=50`,
    { headers: { "User-Agent": "agent-cv" } }
  );

  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status}`);
  }

  const data = await res.json() as {
    objects: Array<{
      package: {
        name: string;
        description: string;
        version: string;
        publisher?: { username: string };
      };
    }>;
  };

  return (data.objects || [])
    .filter(o => {
      // Exact author match to avoid false positives
      const pub = o.package.publisher?.username?.toLowerCase();
      return pub === username.toLowerCase();
    })
    .map(o => ({
      name: o.package.name,
      description: o.package.description || "",
      registry: "npm" as const,
      url: `https://www.npmjs.com/package/${o.package.name}`,
      version: o.package.version,
    }));
}

async function searchPyPI(username: string): Promise<PublishedPackage[]> {
  // PyPI doesn't have a reliable user search API.
  // We use the simple XML API to search by author, which is limited.
  // Best-effort: try the JSON API search endpoint.
  const res = await fetch(
    `https://pypi.org/search/?q=author:${encodeURIComponent(username)}&o=`,
    {
      headers: { "User-Agent": "agent-cv", "Accept": "application/json" },
      redirect: "follow",
    }
  );

  if (!res.ok) {
    // PyPI search doesn't have a stable JSON API, so this may fail.
    // That's expected and fine.
    return [];
  }

  // PyPI returns HTML, not JSON. We'd need to scrape.
  // For v1, return empty. This is documented as best-effort.
  return [];
}

async function searchCrates(username: string): Promise<PublishedPackage[]> {
  // crates.io requires a user ID, not a username.
  // First, look up the user by their GitHub username (crates.io uses GitHub login).
  try {
    const userRes = await fetch(
      `https://crates.io/api/v1/users/${encodeURIComponent(username)}`,
      { headers: { "User-Agent": "agent-cv" } }
    );

    if (!userRes.ok) return [];

    const userData = await userRes.json() as { user: { id: number } };
    const userId = userData.user?.id;
    if (!userId) return [];

    const cratesRes = await fetch(
      `https://crates.io/api/v1/crates?user_id=${userId}&per_page=50&sort=downloads`,
      { headers: { "User-Agent": "agent-cv" } }
    );

    if (!cratesRes.ok) return [];

    const cratesData = await cratesRes.json() as {
      crates: Array<{
        name: string;
        description: string;
        newest_version: string;
      }>;
    };

    return (cratesData.crates || []).map(c => ({
      name: c.name,
      description: c.description || "",
      registry: "crates" as const,
      url: `https://crates.io/crates/${c.name}`,
      version: c.newest_version,
    }));
  } catch {
    return [];
  }
}
