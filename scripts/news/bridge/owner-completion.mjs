const LEGACY_REPOSITORY = 'sustynats/wirkungsoekonomie.de';
const PRIVATE_REPOSITORY = 'sustynats/wirkungsoekonomie-produktiv';
const OWNER = /^\d{1,20}:\d{1,5}$/;

// A missing or inaccessible run is never proof that its owner has stopped.
// GitHub run IDs are verified against both the returned ID and repository.
export async function ownerCompleted(owner, {
  fetchImpl = fetch,
  privateReadToken = process.env.WOEK_NEWS_GITHUB_RUN_READ_TOKEN,
  timeoutMs = 15000,
} = {}) {
  if (!OWNER.test(owner || '')) return false;
  const [id] = owner.split(':');
  const repositories = [{ name: LEGACY_REPOSITORY, token: null }];
  if (privateReadToken) repositories.push({ name: PRIVATE_REPOSITORY, token: privateReadToken });
  for (const { name, token } of repositories) {
    try {
      const headers = { Accept: 'application/vnd.github+json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetchImpl(`https://api.github.com/repos/${name}/actions/runs/${id}`, {
        headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      });
      if (!response.ok) continue;
      const run = await response.json();
      if (!Number.isSafeInteger(run?.id) || String(run.id) !== id || run?.repository?.full_name !== name) return false;
      return run.status === 'completed';
    } catch {
      // Network errors and ambiguous responses leave the lock held.
    }
  }
  return false;
}
