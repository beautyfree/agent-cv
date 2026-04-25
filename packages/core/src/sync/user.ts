import { readAuthToken } from "../auth/index.ts";

/**
 * Resolve the current sync userId.
 *
 * Writes before authentication use a `"local"` sentinel. On first authentication,
 * `promoteLocalUserId()` rewrites all local rows with the real GitHub username so
 * they can be pushed to the server on the next `syncNow()`.
 */
export const LOCAL_USER_ID = "local";

export async function getCurrentUserId(): Promise<string> {
  const auth = await readAuthToken();
  return auth?.username ?? LOCAL_USER_ID;
}

/** True only when the user is authenticated with a real account. */
export async function hasAuthedUser(): Promise<boolean> {
  const auth = await readAuthToken();
  return !!auth?.username;
}

/**
 * Re-scope all locally-written rows (userId === "local") to the authenticated
 * user. Called once right after successful login so pending rows get pushed
 * under the real identity on the next `syncNow()`.
 */
export async function promoteLocalUserId(realUserId: string): Promise<number> {
  if (realUserId === LOCAL_USER_ID) return 0;
  const { getSyncClient } = await import("./client.ts");
  const client = await getSyncClient();

  let promoted = 0;
  for (const model of ["project", "profile", "override"] as const) {
    const rows = await client
      .model(model)
      .findMany({ userId: LOCAL_USER_ID });
    for (const row of rows as Array<Record<string, unknown>>) {
      if (model === "profile") {
        await client.model("profile").delete(LOCAL_USER_ID);
        await client.model("profile").insert({ ...row, userId: realUserId });
      } else {
        await client.model(model).update(row.id as string, {
          ...row,
          userId: realUserId,
        });
      }
      promoted++;
    }
  }
  return promoted;
}
