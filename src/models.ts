export interface OmpModelMeta {
  id: string;
  name?: string;
  provider?: string;
  contextWindow?: number;
  [key: string]: unknown;
}

/**
 * Produces the canonical, unambiguous CLI model selector string for OMP (e.g. `litellm/openai/gpt-5.6-luna`).
 * If the model id already starts with the provider prefix, returns the id as-is.
 */
export function getCanonicalModelSelector(model: { id: string; provider?: string }): string {
  if (model.provider && !model.id.toLowerCase().startsWith(model.provider.toLowerCase() + "/")) {
    return `${ model.provider }/${ model.id }`;
  }
  return model.id;
}

/**
 * Resolves a user-provided model name or identifier into a canonical OMP model selector.
 * Matches against exact provider/id, model id, display name, suffix, or unique partial substring.
 * Falls back to the trimmed input if no match is found or models list is empty.
 */
export function resolveModelSelector(
  input: string,
  models?: OmpModelMeta[],
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (!models || models.length === 0) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();

  // 1. Direct match on full canonical provider/id
  const exactQualified = models.find(
    (m) => m.provider && `${ m.provider }/${ m.id }`.toLowerCase() === lower,
  );
  if (exactQualified) {
    return getCanonicalModelSelector(exactQualified);
  }

  // 2. Exact match on model id
  const exactId = models.find((m) => m.id.toLowerCase() === lower);
  if (exactId) {
    return getCanonicalModelSelector(exactId);
  }

  // 3. Exact match on model display name
  const exactName = models.find((m) => m.name && m.name.toLowerCase() === lower);
  if (exactName) {
    return getCanonicalModelSelector(exactName);
  }

  // 4. Suffix match on id (e.g. "gpt-5.6-luna" matches "openai/gpt-5.6-luna")
  const suffixMatch = models.find((m) =>
    m.id.toLowerCase().endsWith("/" + lower),
  );
  if (suffixMatch) {
    return getCanonicalModelSelector(suffixMatch);
  }

  // 5. Unambiguous partial match (only if exactly 1 model matches)
  const partialMatches = models.filter(
    (m) =>
      m.id.toLowerCase().includes(lower) ||
      (m.name && m.name.toLowerCase().includes(lower)),
  );
  if (partialMatches.length === 1) {
    return getCanonicalModelSelector(partialMatches[0]);
  }

  // Fallback: return trimmed input
  return trimmed;
}

/**
 * Determines whether a given model string corresponds to a known available model.
 * Always returns true if the models list is not available or empty.
 */
export function isKnownModel(
  input: string,
  models?: OmpModelMeta[],
): boolean {
  if (!models || models.length === 0) {
    return true;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  return models.some(
    (m) =>
      (m.provider && `${ m.provider }/${ m.id }`.toLowerCase() === lower) ||
      m.id.toLowerCase() === lower ||
      (m.name && m.name.toLowerCase() === lower) ||
      m.id.toLowerCase().endsWith("/" + lower) ||
      m.id.toLowerCase().includes(lower) ||
      (m.name && m.name.toLowerCase().includes(lower)),
  );
}

/**
 * Filters and formats available models for Discord autocomplete suggestions.
 * Values are canonical selectors ensuring safe CLI and RPC invocation.
 */
export function getModelSuggestions(
  queryRaw: string,
  models: OmpModelMeta[] = [],
): Array<{ name: string; value: string }> {
  const query = queryRaw.toLowerCase().trim();
  return models
    .filter((m) => {
      if (!query) {
        return true;
      }
      const qualified = m.provider ? `${ m.provider }/${ m.id }` : m.id;
      return (
        m.id.toLowerCase().includes(query) ||
        (m.name && m.name.toLowerCase().includes(query)) ||
        qualified.toLowerCase().includes(query)
      );
    })
    .slice(0, 25)
    .map((m) => ({
      name: `${ m.name || m.id } [${ m.provider || "omp" }] (${ Math.round((m.contextWindow || 0) / 1000) }k ctx)`.slice(0, 100),
      value: getCanonicalModelSelector(m),
    }));
}
