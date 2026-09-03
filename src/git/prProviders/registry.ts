import type { PushRemote } from "../pushRemote";
import { forgejoProvider } from "./forgejo";
import { githubProvider } from "./github";
// Ordered registry of PR comment providers. First `matches()` wins.
// To add GitLab (or anything else): implement PrCommentsProvider, then
// `registerPrCommentsProvider(gitlabProvider)` before the Forgejo fallback
// (or insert ahead of it in DEFAULT_PROVIDERS).
import type { ProviderHints, PrCommentsProvider } from "./types";

const DEFAULT_PROVIDERS: PrCommentsProvider[] = [githubProvider, forgejoProvider];

let providers: PrCommentsProvider[] = [...DEFAULT_PROVIDERS];

/** Replace the registry (tests). Prefer registerPrCommentsProvider for forks. */
export function setPrCommentsProviders(next: PrCommentsProvider[]): void {
  providers = next.length ? [...next] : [...DEFAULT_PROVIDERS];
}

export function resetPrCommentsProviders(): void {
  providers = [...DEFAULT_PROVIDERS];
}

/**
 * Insert a provider before the fallback (last) entry, or at the end if alone.
 * Typical fork: register GitLab so it runs after GitHub and before Forgejo.
 */
export function registerPrCommentsProvider(provider: PrCommentsProvider): void {
  const without = providers.filter((p) => p.id !== provider.id);
  if (without.length === 0) {
    providers = [provider];
    return;
  }
  // Keep the last provider as catch-all (Forgejo today).
  const fallback = without[without.length - 1]!;
  const head = without.slice(0, -1);
  providers = [...head, provider, fallback];
}

export function listPrCommentsProviders(): readonly PrCommentsProvider[] {
  return providers;
}

export function resolvePrCommentsProvider(
  remote: PushRemote | null,
  hints: ProviderHints = {},
): PrCommentsProvider {
  for (const provider of providers) {
    if (provider.matches(remote, hints)) {
      return provider;
    }
  }
  // Registry should always end with a catch-all; keep a hard fallback anyway.
  return providers[providers.length - 1] ?? forgejoProvider;
}
