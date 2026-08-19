use std::collections::HashMap;
use std::hash::Hash;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use super::{DefinitionLookupError, RepoDefinitions};
use crate::db::Repo;

const REPO_DEFINITION_CACHE_TTL: Duration = Duration::from_secs(30);

struct TimedEntry<V> {
    loaded_at: Instant,
    value: Arc<V>,
}

enum CacheEntry<V, E> {
    Ready(TimedEntry<V>),
    Loading(Arc<LoadFlight<V, E>>),
}

struct LoadFlight<V, E> {
    result: Mutex<Option<Result<Arc<V>, E>>>,
    ready: Condvar,
}

impl<V, E> LoadFlight<V, E>
where
    E: Clone,
{
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            ready: Condvar::new(),
        }
    }

    fn wait(&self) -> Result<Arc<V>, E> {
        let mut result = self
            .result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        loop {
            if let Some(result) = result.as_ref() {
                return result.clone();
            }
            result = self
                .ready
                .wait(result)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }

    fn finish(&self, result: Result<Arc<V>, E>) {
        *self
            .result
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(result);
        self.ready.notify_all();
    }
}

struct TimedCache<K, V, E> {
    ttl: Duration,
    entries: Mutex<HashMap<K, CacheEntry<V, E>>>,
}

impl<K, V, E> TimedCache<K, V, E>
where
    K: Clone + Eq + Hash,
    E: Clone + From<String>,
{
    fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn get_or_try_insert_with(
        &self,
        key: K,
        now: Instant,
        load: impl FnOnce() -> Result<V, E>,
    ) -> Result<Arc<V>, E> {
        let (flight, should_load) = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match entries.get(&key) {
                Some(CacheEntry::Ready(entry))
                    if now.duration_since(entry.loaded_at) < self.ttl =>
                {
                    return Ok(Arc::clone(&entry.value));
                }
                Some(CacheEntry::Loading(flight)) => (Arc::clone(flight), false),
                Some(CacheEntry::Ready(_)) | None => {
                    let flight = Arc::new(LoadFlight::new());
                    entries.insert(key.clone(), CacheEntry::Loading(Arc::clone(&flight)));
                    (flight, true)
                }
            }
        };
        if !should_load {
            return flight.wait();
        }

        let result = match catch_unwind(AssertUnwindSafe(load)) {
            Ok(result) => result,
            Err(payload) => {
                let message = payload
                    .downcast_ref::<&str>()
                    .map(|message| (*message).to_string())
                    .or_else(|| payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "unknown panic payload".to_string());
                Err(E::from(format!(
                    "repository definition loader panicked: {message}"
                )))
            }
        }
        .map(Arc::new);
        let returned = result.clone();
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &result {
            Ok(value) => {
                entries.insert(
                    key,
                    CacheEntry::Ready(TimedEntry {
                        loaded_at: Instant::now(),
                        value: Arc::clone(value),
                    }),
                );
            }
            Err(_) => {
                entries.remove(&key);
            }
        }
        drop(entries);
        flight.finish(result);
        returned
    }

    /// Forget a ready entry. A load already in flight is left alone: it will
    /// install its own result, and cancelling it would strand its waiters.
    fn invalidate(&self, key: &K) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(entries.get(key), Some(CacheEntry::Ready(_))) {
            entries.remove(key);
        }
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
    definitions: TimedCache<RepoDefinitionCacheKey, RepoDefinitions, DefinitionLookupError>,
    #[cfg(test)]
    before_load: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl Default for RepoDefinitionsCache {
    fn default() -> Self {
        Self {
            definitions: TimedCache::new(REPO_DEFINITION_CACHE_TTL),
            #[cfg(test)]
            before_load: Mutex::new(None),
        }
    }
}

impl RepoDefinitionsCache {
    #[cfg(test)]
    pub(crate) fn set_before_load(&self, before_load: Arc<dyn Fn() + Send + Sync>) {
        *self
            .before_load
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(before_load);
    }

    #[cfg(test)]
    fn run_before_load(&self) {
        let before_load = self
            .before_load
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if let Some(before_load) = before_load {
            before_load();
        }
    }

    pub(super) fn with_definitions<T>(
        &self,
        repo: &Repo,
        read: impl FnOnce(&RepoDefinitions) -> Result<T, DefinitionLookupError>,
    ) -> Result<T, DefinitionLookupError> {
        let definitions = self.definitions.get_or_try_insert_with(
            RepoDefinitionCacheKey::from(repo),
            Instant::now(),
            || {
                #[cfg(test)]
                self.run_before_load();
                // Cached definitions answer reads that only display them, so
                // they resolve from the refs already on disk. `git fetch` on
                // this path put a network round trip behind ordinary UI
                // refreshes; the operations that must see the real remote tip
                // resolve authoritatively instead of through this cache.
                RepoDefinitions::resolve_local(repo).map_err(DefinitionLookupError::Other)
            },
        )?;
        read(&definitions)
    }

    /// Drop a repo's cached definitions so the next read re-resolves. Pair it
    /// with a fetch when the caller wants the cache to reflect a new remote
    /// tip rather than wait out the TTL.
    pub(crate) fn invalidate(&self, repo: &Repo) {
        self.definitions
            .invalidate(&RepoDefinitionCacheKey::from(repo));
    }
}

#[cfg(test)]
mod tests {
    use super::TimedCache;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier, Condvar, Mutex};
    use std::time::{Duration, Instant};

    struct LoaderGate {
        loads: AtomicUsize,
        started: Condvar,
        release: Condvar,
        state: Mutex<(usize, bool)>,
    }

    impl LoaderGate {
        fn new() -> Self {
            Self {
                loads: AtomicUsize::new(0),
                started: Condvar::new(),
                release: Condvar::new(),
                state: Mutex::new((0, false)),
            }
        }

        fn load<T>(&self, result: Result<T, String>) -> Result<T, String> {
            self.hold();
            result
        }

        fn hold(&self) {
            self.loads.fetch_add(1, Ordering::SeqCst);
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.0 += 1;
            self.started.notify_all();
            while !state.1 {
                state = self
                    .release
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }

        fn wait_until_started(&self) {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            while state.0 == 0 {
                state = self
                    .started
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        }

        fn release(&self) {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.1 = true;
            self.release.notify_all();
        }
    }

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
            .get_or_try_insert_with("repo", started + Duration::from_secs(31), || {
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

        let failed = cache.get_or_try_insert_with("repo", started, || {
            Err::<&str, _>("unavailable".to_string())
        });
        let recovered = cache
            .get_or_try_insert_with("repo", started, || Ok::<_, String>("revision-1"))
            .unwrap();

        assert_eq!(failed.unwrap_err(), "unavailable");
        assert_eq!(*recovered, "revision-1");
    }

    #[test]
    fn concurrent_misses_share_one_load() {
        let cache = Arc::new(TimedCache::new(Duration::from_secs(30)));
        let gate = Arc::new(LoaderGate::new());
        let callers = Arc::new(Barrier::new(3));
        let started = Instant::now();

        let handles: Vec<_> = (0..2)
            .map(|_| {
                let cache = Arc::clone(&cache);
                let gate = Arc::clone(&gate);
                let callers = Arc::clone(&callers);
                std::thread::spawn(move || {
                    callers.wait();
                    cache
                        .get_or_try_insert_with("repo", started, || {
                            gate.load(Ok("revision-1".to_string()))
                        })
                        .unwrap()
                })
            })
            .collect();

        callers.wait();
        gate.wait_until_started();
        std::thread::sleep(Duration::from_millis(50));
        let loads_while_blocked = gate.loads.load(Ordering::SeqCst);
        gate.release();
        let values: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();

        assert_eq!(loads_while_blocked, 1);
        assert_eq!(gate.loads.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(&values[0], &values[1]));
        assert_eq!(values[0].as_str(), "revision-1");
    }

    #[test]
    fn concurrent_failed_load_is_shared_and_later_request_retries() {
        let cache = Arc::new(TimedCache::new(Duration::from_secs(30)));
        let gate = Arc::new(LoaderGate::new());
        let callers = Arc::new(Barrier::new(3));
        let started = Instant::now();

        let handles: Vec<_> = (0..2)
            .map(|_| {
                let cache = Arc::clone(&cache);
                let gate = Arc::clone(&gate);
                let callers = Arc::clone(&callers);
                std::thread::spawn(move || {
                    callers.wait();
                    cache.get_or_try_insert_with("repo", started, || {
                        gate.load(Err::<String, _>("unavailable".to_string()))
                    })
                })
            })
            .collect();

        callers.wait();
        gate.wait_until_started();
        std::thread::sleep(Duration::from_millis(50));
        let loads_while_blocked = gate.loads.load(Ordering::SeqCst);
        gate.release();
        let errors: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap().unwrap_err())
            .collect();
        let recovered = cache
            .get_or_try_insert_with("repo", started, || {
                gate.loads.fetch_add(1, Ordering::SeqCst);
                Ok::<_, String>("revision-1".to_string())
            })
            .unwrap();

        assert_eq!(loads_while_blocked, 1);
        assert_eq!(errors, ["unavailable", "unavailable"]);
        assert_eq!(recovered.as_str(), "revision-1");
        assert_eq!(gate.loads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn concurrent_loader_panic_releases_waiters_and_later_request_retries() {
        let cache = Arc::new(TimedCache::new(Duration::from_secs(30)));
        let gate = Arc::new(LoaderGate::new());
        let callers = Arc::new(Barrier::new(3));
        let started = Instant::now();
        let (result_tx, result_rx) = std::sync::mpsc::channel();

        for _ in 0..2 {
            let cache = Arc::clone(&cache);
            let gate = Arc::clone(&gate);
            let callers = Arc::clone(&callers);
            let result_tx = result_tx.clone();
            std::thread::spawn(move || {
                callers.wait();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    cache.get_or_try_insert_with("repo", started, || -> Result<String, String> {
                        gate.hold();
                        panic!("definition loader panic")
                    })
                }));
                result_tx.send(result).unwrap();
            });
        }
        drop(result_tx);

        callers.wait();
        gate.wait_until_started();
        gate.release();
        let results: Vec<_> = (0..2)
            .map(|_| {
                result_rx
                    // A liveness wait, not a budget: a caller left hanging by
                    // the panic never sends at all, so the ceiling only has to
                    // be finite and clear of load-induced scheduling delay.
                    .recv_timeout(Duration::from_secs(10))
                    .expect("every shared-load caller completed after the panic")
            })
            .collect();
        let recovered = cache
            .get_or_try_insert_with("repo", started, || {
                Ok::<_, String>("revision-1".to_string())
            })
            .unwrap();

        for result in results {
            let error = result.expect("loader panic was converted into a cache error");
            assert!(error.unwrap_err().contains("definition loader panic"));
        }
        assert_eq!(recovered.as_str(), "revision-1");
    }
}
