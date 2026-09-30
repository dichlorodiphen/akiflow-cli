# Cache storage

The cache root (`AF_CACHE_DIR`, default `~/.cache/af`) contains an atomic
`current` pointer to an immutable `gen-*` directory. Each generation contains
all eight resource JSONL files, `tokens.json`, and a manifest recording its
identity, creation time, resource counts and SHA-256 hashes, and token hash.
Rebuilds, refreshes and write-through updates stage and validate a complete
replacement before publishing the pointer. Readers pin a generation for a
read. Publication uses temporary files in the destination directory and
rename; this provides crash atomicity for readers, **not power-loss durability**.
There is no fsync guarantee.

The sibling `<cache-root>.lock` contains a PID, random owner nonce and heartbeat
timestamp. Live owner processes retain their locks regardless of age. Dead
owners can be reclaimed immediately; release checks identity. A persistent
sibling `.lock.reclaim` guard uses kernel flock (via Bun FFI on Linux/macOS)
to serialize lock transitions and prevent competing reclaimers deleting a new
owner. The guard file stays in place; the kernel releases it on process death. Stale staging
files left by killed processes are cleaned under the next writer's lock.
The last two old generations are retained for inspection; older generations
have a grace period before garbage collection.

Existing flat caches are copied into generation zero and validated before the
pointer is published. Original resource files are removed only after publication.
Pending tasks (`pending-tasks.json`), task-list context (`last-list.json`), the
legacy task cache and its metadata, logs, and other root files survive rebuilds.
Rebuild and refresh only call the client's GET interface.

Tokens track `last_success_at` per resource. Only a successful pass syncing all
eight resources updates `last_full_sync_at`. Automatic refresh checks the
requested resource's timestamp and refreshes if it is missing or older than
24 hours. `AF_NO_AUTO_SYNC=1`, `true`, `yes`, or `on` (case insensitive, allowing
surrounding whitespace) disables automatic sync. Empty, `0`, `false`, and other
values leave automatic sync enabled.

Waiters block until a live owner releases, up to five minutes
(`AF_LOCK_TIMEOUT_MS` overrides, milliseconds; internal/test use), after which
acquisition fails with an error naming the holding PID instead of hanging.

Sync folding, cursor recovery, pending-intent reconciliation and mutation
verification are separate concerns; this storage layer does not change those
semantics.
