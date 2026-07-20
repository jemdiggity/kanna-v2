use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::{DefinitionLookupError, RepoDefinitions};
use crate::db::Repo;

const REPO_DEFINITION_CACHE_TTL: Duration = Duration::from_secs(30);

struct TimedEntry<V> {
    loaded_at: Instant,
    value: Arc<V>,
}

struct TimedCache<K, V> {
    ttl: Duration,
    entries: Mutex<HashMap<K, TimedEntry<V>>>,
}

impl<K, V> TimedCache<K, V>
where
    K: Clone + Eq + Hash,
{
    fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn get_or_try_insert_with<E>(
        &self,
        key: K,
        now: Instant,
        load: impl FnOnce() -> Result<V, E>,
    ) -> Result<Arc<V>, E> {
        if let Some(value) = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .filter(|entry| now.duration_since(entry.loaded_at) < self.ttl)
            .map(|entry| Arc::clone(&entry.value))
        {
            return Ok(value);
        }

        let value = Arc::new(load()?);
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                key,
                TimedEntry {
                    loaded_at: now,
                    value: Arc::clone(&value),
                },
            );
        Ok(value)
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RepoDefinitionCacheKey {
    id: String,
    path: String,
    default_branch: Option<String>,
}

impl From<&Repo> for RepoDefinitionCacheKey {
    fn from(repo: &Repo) -> Self {
        Self {
            id: repo.id.clone(),
            path: repo.path.clone(),
            default_branch: repo.default_branch.clone(),
        }
    }
}

pub(crate) struct RepoDefinitionsCache {
    definitions: TimedCache<RepoDefinitionCacheKey, RepoDefinitions>,
}

impl Default for RepoDefinitionsCache {
    fn default() -> Self {
        Self {
            definitions: TimedCache::new(REPO_DEFINITION_CACHE_TTL),
        }
    }
}

impl RepoDefinitionsCache {
    pub(super) fn with_definitions<T>(
        &self,
        repo: &Repo,
        read: impl FnOnce(&RepoDefinitions) -> Result<T, DefinitionLookupError>,
    ) -> Result<T, DefinitionLookupError> {
        let definitions = self.definitions.get_or_try_insert_with(
            RepoDefinitionCacheKey::from(repo),
            Instant::now(),
            || RepoDefinitions::resolve(repo).map_err(DefinitionLookupError::Other),
        )?;
        read(&definitions)
    }
}

#[cfg(test)]
mod tests {
    use super::TimedCache;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    #[test]
    fn fresh_entry_reuses_the_loaded_value() {
        let cache = TimedCache::new(Duration::from_secs(30));
        let loads = AtomicUsize::new(0);
        let started = Instant::now();

        let first = cache
            .get_or_try_insert_with("repo", started, || {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok::<_, String>("revision-1".to_string())
            })
            .unwrap();
        let second = cache
            .get_or_try_insert_with("repo", started + Duration::from_secs(1), || {
                loads.fetch_add(1, Ordering::SeqCst);
                Ok::<_, String>("revision-2".to_string())
            })
            .unwrap();

        assert_eq!(first.as_str(), "revision-1");
        assert_eq!(second.as_str(), "revision-1");
        assert_eq!(loads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn expired_entry_loads_a_new_value() {
        let cache = TimedCache::new(Duration::from_secs(30));
        let started = Instant::now();

        cache
            .get_or_try_insert_with("repo", started, || Ok::<_, String>("revision-1"))
            .unwrap();
        let refreshed = cache
            .get_or_try_insert_with("repo", started + Duration::from_secs(30), || {
                Ok::<_, String>("revision-2")
            })
            .unwrap();

        assert_eq!(*refreshed, "revision-2");
    }

    #[test]
    fn entries_are_isolated_by_key() {
        let cache = TimedCache::new(Duration::from_secs(30));
        let started = Instant::now();

        let first = cache
            .get_or_try_insert_with("repo-1", started, || Ok::<_, String>("revision-1"))
            .unwrap();
        let second = cache
            .get_or_try_insert_with("repo-2", started, || Ok::<_, String>("revision-2"))
            .unwrap();

        assert_eq!(*first, "revision-1");
        assert_eq!(*second, "revision-2");
    }

    #[test]
    fn failed_load_is_not_cached() {
        let cache = TimedCache::new(Duration::from_secs(30));
        let started = Instant::now();

        let failed =
            cache.get_or_try_insert_with("repo", started, || Err::<&str, _>("unavailable"));
        let recovered = cache
            .get_or_try_insert_with("repo", started, || Ok::<_, &str>("revision-1"))
            .unwrap();

        assert_eq!(failed.unwrap_err(), "unavailable");
        assert_eq!(*recovered, "revision-1");
    }
}
