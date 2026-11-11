/*
 * iclone_fsevents — the F7 hard-link guard's own macOS FSEvents binding (v0.0.7, replaces the `fsevents` npm module).
 *
 * Why our own: fsevents 2.3.2 ignores the results of FSEventStreamCreate and FSEventStreamStart, so a stream that
 * fseventsd refused looks healthy (review L1-1), and it has neither FSEventsGetCurrentEventId nor
 * FSEventStreamFlushSync, which an exact delivery barrier needs. Here every failure to create or start throws.
 *
 * N-API only (node_api.h, version 8): ABI-stable, so the same .node loads in Node and in Electron's main process.
 *
 *   currentEventId()            -> string   FSEventsGetCurrentEventId(), uint64 in decimal
 *   start(paths, onEvents)      -> handle   one stream on 1-4 existing, readable, absolute directories (a string or an
 *                                           array); throws on any failure; onEvents([{ path, flags, id }]) on the JS thread, in id order
 *   flush(handle)               -> Promise  FSEventStreamFlushSync off the JS thread; resolves after every event
 *                                           fseventsd had for the stream when the flush ran has reached onEvents
 *   latestEventId(handle)       -> string | null   FSEventStreamGetLatestEventId; null once stopped
 *   stop(handle)                -> void     stop + invalidate + release; idempotent; also when the handle is collected
 *   activeCount()               -> number   streams started and not yet fully released (leak checks)
 *   testDropNextBatch(handle)   -> void     test seam: the stream's next batch is dropped as if out of memory
 *   volume(path)                -> Promise<{ fstypename, local }>   statfs(2) on a libuv worker: the filesystem's type
 *                                           NAME (type numbers are assigned at registration, review L1-3) and MNT_LOCAL
 *
 * Threads: the stream's callback runs on its own serial dispatch queue; flush and stop run, in call order, on a second
 * serial "control" queue, so a flush never runs on a released stream. Events and flush completions go through ONE
 * threadsafe function, whose queue is FIFO: a flush resolves only after every batch the callback queued before the
 * flush returned has been handed to onEvents. The threadsafe function is released only after the stream is
 * invalidated and its queue has drained, so no callback outlives it.
 *
 * Loss (v0.0.7 CF1, critic A-m1): a batch the callback cannot hand on (calloc or strdup failed, the threadsafe
 * function refused it) is never dropped silently. The watch's `lost` flag is set, and the next batch that does go
 * through carries first a synthetic event { path: the first watched path, flags: MustScanSubDirs, id: 0 }: the
 * adapter's loss rule voids the stream and the guard walks. A barrier written after the loss is in that next batch,
 * so it cannot pass before the loss is seen; if no batch goes through any more, no canary does either, and the
 * barrier times out (the guard walks).
 */
#include <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#define NAPI_VERSION 8
#include <node_api.h>

static const FSEventStreamCreateFlags CREATE_FLAGS =
    kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagWatchRoot;
/* 1 ms: measured, a canary on the stream is delivered p50 0.9 ms / p95 1.9 ms idle (10 ms latency: p50 9.9 ms). */
static const CFTimeInterval LATENCY_S = 0.001;
#define MAX_PATHS 4

static atomic_int g_active = 0;

typedef struct Watch {
  FSEventStreamRef stream;
  dispatch_queue_t events_queue;
  dispatch_queue_t control_queue;
  napi_threadsafe_function tsfn;
  napi_ref on_events;
  /* events_queue only (set by a failed hand-off, read and cleared by the next batch), and the test seam's request. */
  atomic_bool lost;
  atomic_bool test_drop_next;
  /* The first watched path, for the synthetic loss event (set before the stream starts, then read-only). */
  char loss_path[PATH_MAX + 1];
  /* JS thread only. */
  int stopped;
  int pending_flushes;
  int refs; /* the handle + the threadsafe function; freed at 0 */
} Watch;

enum ItemKind { ITEM_EVENTS = 1, ITEM_FLUSHED = 2 };

typedef struct Item {
  enum ItemKind kind;
  /* ITEM_EVENTS */
  size_t count;
  char **paths;
  FSEventStreamEventFlags *flags;
  FSEventStreamEventId *ids;
  /* ITEM_FLUSHED */
  napi_deferred deferred;
} Item;

#define CHECK(env, call)                                                                                               \
  do {                                                                                                                 \
    if ((call) != napi_ok) {                                                                                           \
      return throw_last(env, #call);                                                                                   \
    }                                                                                                                  \
  } while (0)

static napi_value throw_last(napi_env env, const char *where) {
  const napi_extended_error_info *info = NULL;
  napi_get_last_error_info(env, &info);
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) {
    char message[256];
    snprintf(message, sizeof message, "iclone_fsevents: %s failed (%s)", where,
             info && info->error_message ? info->error_message : "napi error");
    napi_throw_error(env, "EFSEVENTS", message);
  }
  return NULL;
}

static napi_value throw_code(napi_env env, const char *code, const char *message) {
  napi_throw_error(env, code, message);
  return NULL;
}

static napi_value id_string(napi_env env, uint64_t id) {
  char text[24];
  snprintf(text, sizeof text, "%" PRIu64, id);
  napi_value value = NULL;
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value);
  return value;
}

static void free_item(Item *item) {
  if (!item) {
    return;
  }
  if (item->paths) {
    for (size_t i = 0; i < item->count; i++) {
      free(item->paths[i]);
    }
  }
  free(item->paths);
  free(item->flags);
  free(item->ids);
  free(item);
}

static void watch_unref(napi_env env, Watch *watch) {
  watch->refs -= 1;
  if (watch->refs > 0) {
    return;
  }
  if (watch->on_events && env) {
    napi_delete_reference(env, watch->on_events);
  }
  free(watch);
}

/* Runs on the JS thread for every item of the threadsafe function, in the order the items were queued. */
static void call_js(napi_env env, napi_value js_cb, void *context, void *data) {
  Watch *watch = context;
  Item *item = data;
  (void)js_cb;

  if (!item) {
    return;
  }

  if (item->kind == ITEM_FLUSHED) {
    if (env) {
      napi_value undefined = NULL;
      napi_get_undefined(env, &undefined);
      napi_resolve_deferred(env, item->deferred, undefined);
      watch->pending_flushes -= 1;
      if (watch->pending_flushes == 0 && watch->tsfn && !watch->stopped) {
        napi_unref_threadsafe_function(env, watch->tsfn);
      }
    }
    free_item(item);
    return;
  }

  if (!env || watch->stopped) {
    free_item(item);
    return;
  }

  napi_value array = NULL;
  napi_value callback = NULL;
  napi_value global = NULL;
  if (napi_create_array_with_length(env, item->count, &array) != napi_ok ||
      napi_get_reference_value(env, watch->on_events, &callback) != napi_ok || !callback ||
      napi_get_global(env, &global) != napi_ok) {
    free_item(item);
    return;
  }

  for (size_t i = 0; i < item->count; i++) {
    napi_value event = NULL;
    napi_value path = NULL;
    napi_value flags = NULL;
    napi_create_object(env, &event);
    napi_create_string_utf8(env, item->paths[i], NAPI_AUTO_LENGTH, &path);
    napi_create_uint32(env, (uint32_t)item->flags[i], &flags);
    napi_set_named_property(env, event, "path", path);
    napi_set_named_property(env, event, "flags", flags);
    napi_set_named_property(env, event, "id", id_string(env, item->ids[i]));
    napi_set_element(env, array, (uint32_t)i, event);
  }
  free_item(item);

  /* An exception thrown by onEvents is the caller's: it surfaces as an uncaught exception, as for any callback. */
  napi_call_function(env, global, callback, 1, &array, NULL);
}

static void tsfn_finalize(napi_env env, void *data, void *hint) {
  Watch *watch = data;
  (void)hint;
  watch->tsfn = NULL;
  atomic_fetch_sub(&g_active, 1);
  watch_unref(env, watch);
}

/* The stream's callback, on events_queue. Copies the batch and queues it; never blocks (unbounded queue). A batch it
 * cannot queue sets `lost`, and the next queued batch starts with the synthetic loss event (header). */
static void stream_callback(ConstFSEventStreamRef stream, void *info, size_t count, void *event_paths,
                            const FSEventStreamEventFlags flags[], const FSEventStreamEventId ids[]) {
  Watch *watch = info;
  char **paths = event_paths;
  (void)stream;

  const bool carry = atomic_exchange(&watch->lost, false);
  const size_t first = carry ? 1 : 0;
  const size_t total = count + first;
  Item *item = atomic_exchange(&watch->test_drop_next, false) ? NULL : calloc(1, sizeof *item);
  if (!item) {
    atomic_store(&watch->lost, true);
    return;
  }
  item->kind = ITEM_EVENTS;
  item->paths = calloc(total ? total : 1, sizeof *item->paths);
  item->flags = calloc(total ? total : 1, sizeof *item->flags);
  item->ids = calloc(total ? total : 1, sizeof *item->ids);
  if (!item->paths || !item->flags || !item->ids) {
    free_item(item);
    atomic_store(&watch->lost, true);
    return;
  }
  if (carry) {
    item->paths[0] = strdup(watch->loss_path);
    item->flags[0] = kFSEventStreamEventFlagMustScanSubDirs;
    item->ids[0] = 0;
    item->count = 1;
    if (!item->paths[0]) {
      free_item(item);
      atomic_store(&watch->lost, true);
      return;
    }
  }
  for (size_t i = 0; i < count; i++) {
    char *copy = strdup(paths[i] ? paths[i] : "");
    if (!copy) {
      free_item(item);
      atomic_store(&watch->lost, true);
      return;
    }
    item->paths[first + i] = copy;
    item->flags[first + i] = flags[i];
    item->ids[first + i] = ids[i];
    item->count = first + i + 1;
  }
  if (napi_call_threadsafe_function(watch->tsfn, item, napi_tsfn_nonblocking) != napi_ok) {
    free_item(item);
    atomic_store(&watch->lost, true);
  }
}

static Watch *unwrap(napi_env env, napi_value handle) {
  Watch *watch = NULL;
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, handle, &type) != napi_ok || type != napi_external) {
    return NULL;
  }
  if (napi_get_value_external(env, handle, (void **)&watch) != napi_ok) {
    return NULL;
  }
  return watch;
}

static void drained(void *context) { (void)context; }

/* On control_queue: stop, invalidate and release the stream, wait for its queue to drain, then let the threadsafe
 * function go (its finalizer runs on the JS thread and drops the last native reference). */
static void stop_on_control(void *context) {
  Watch *watch = context;
  FSEventStreamStop(watch->stream);
  FSEventStreamInvalidate(watch->stream);
  FSEventStreamRelease(watch->stream);
  watch->stream = NULL;
  dispatch_sync_f(watch->events_queue, NULL, drained);
  dispatch_release(watch->events_queue);
  napi_threadsafe_function tsfn = watch->tsfn;
  dispatch_queue_t control = watch->control_queue;
  napi_release_threadsafe_function(tsfn, napi_tsfn_release);
  /* Safe while running on it: a queue is retained for as long as one of its blocks executes. */
  dispatch_release(control);
}

static void stop_watch(napi_env env, Watch *watch) {
  if (watch->stopped) {
    return;
  }
  watch->stopped = 1;
  if (!watch->tsfn) {
    /* Environment teardown already finalized the threadsafe function: nothing can be delivered any more. */
    FSEventStreamStop(watch->stream);
    FSEventStreamInvalidate(watch->stream);
    FSEventStreamRelease(watch->stream);
    watch->stream = NULL;
    return;
  }
  /* Unref'd from here on: a stopped stream never holds the process open while its release drains. */
  napi_unref_threadsafe_function(env, watch->tsfn);
  dispatch_async_f(watch->control_queue, watch, stop_on_control);
}

static void handle_finalize(napi_env env, void *data, void *hint) {
  Watch *watch = data;
  (void)hint;
  stop_watch(env, watch);
  watch_unref(env, watch);
}

static napi_value js_current_event_id(napi_env env, napi_callback_info info) {
  (void)info;
  return id_string(env, (uint64_t)FSEventsGetCurrentEventId());
}

/* Test seam (CF1): the next batch of this stream is dropped as an allocation failure would drop it. */
static napi_value js_test_drop_next_batch(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Watch *watch = argc ? unwrap(env, argv[0]) : NULL;
  if (!watch) {
    return throw_code(env, "EINVAL", "iclone_fsevents.testDropNextBatch: not a handle");
  }
  atomic_store(&watch->test_drop_next, true);
  return NULL;
}

static napi_value js_active_count(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value value = NULL;
  napi_create_int32(env, atomic_load(&g_active), &value);
  return value;
}

static napi_value js_start(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (argc < 2) {
    return throw_code(env, "EINVAL", "iclone_fsevents.start(path, onEvents)");
  }

  napi_valuetype type = napi_undefined;
  CHECK(env, napi_typeof(env, argv[1], &type));
  if (type != napi_function) {
    return throw_code(env, "EINVAL", "iclone_fsevents.start: onEvents must be a function");
  }

  napi_value list[MAX_PATHS];
  uint32_t count = 0;
  bool is_array = false;
  CHECK(env, napi_is_array(env, argv[0], &is_array));
  if (is_array) {
    CHECK(env, napi_get_array_length(env, argv[0], &count));
    if (count == 0 || count > MAX_PATHS) {
      return throw_code(env, "EINVAL", "iclone_fsevents.start: between 1 and 4 paths");
    }
    for (uint32_t i = 0; i < count; i++) {
      CHECK(env, napi_get_element(env, argv[0], i, &list[i]));
    }
  } else {
    list[0] = argv[0];
    count = 1;
  }

  char paths_c[MAX_PATHS][PATH_MAX + 1];
  for (uint32_t i = 0; i < count; i++) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, list[i], paths_c[i], sizeof paths_c[i], &length) != napi_ok || length == 0 ||
        length >= PATH_MAX || paths_c[i][0] != '/' || strlen(paths_c[i]) != length) {
      return throw_code(env, "EINVAL", "iclone_fsevents.start: every path must be an absolute path");
    }
    /* A stream on a missing or unreadable path is accepted by FSEvents and reports nothing: refuse it here. */
    int fd = open(paths_c[i], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) {
      int error = errno;
      char message[160];
      snprintf(message, sizeof message, "iclone_fsevents.start: cannot open the directory (%s)", strerror(error));
      return throw_code(env, error == ENOENT ? "ENOENT" : error == EACCES ? "EACCES" : "EFSEVENTS", message);
    }
    close(fd);
  }

  Watch *watch = calloc(1, sizeof *watch);
  if (!watch) {
    return throw_code(env, "ENOMEM", "iclone_fsevents.start: out of memory");
  }

  napi_value resource_name = NULL;
  napi_create_string_utf8(env, "iclone_fsevents", NAPI_AUTO_LENGTH, &resource_name);
  if (napi_create_reference(env, argv[1], 1, &watch->on_events) != napi_ok ||
      napi_create_threadsafe_function(env, NULL, NULL, resource_name, 0, 1, watch, tsfn_finalize, watch, call_js,
                                      &watch->tsfn) != napi_ok) {
    if (watch->on_events) {
      napi_delete_reference(env, watch->on_events);
    }
    free(watch);
    return throw_code(env, "EFSEVENTS", "iclone_fsevents.start: cannot create the threadsafe function");
  }
  atomic_fetch_add(&g_active, 1);
  atomic_init(&watch->lost, false);
  atomic_init(&watch->test_drop_next, false);
  memcpy(watch->loss_path, paths_c[0], sizeof watch->loss_path);
  watch->refs = 1; /* the threadsafe function's; the handle's is added below */
  napi_unref_threadsafe_function(env, watch->tsfn);

  CFStringRef cf_paths[MAX_PATHS] = {NULL};
  uint32_t made = 0;
  while (made < count &&
         (cf_paths[made] = CFStringCreateWithCString(kCFAllocatorDefault, paths_c[made], kCFStringEncodingUTF8))) {
    made += 1;
  }
  CFArrayRef paths =
      made == count ? CFArrayCreate(kCFAllocatorDefault, (const void **)cf_paths, count, &kCFTypeArrayCallBacks) : NULL;
  FSEventStreamContext context = {0, watch, NULL, NULL, NULL};
  watch->stream = paths ? FSEventStreamCreate(kCFAllocatorDefault, stream_callback, &context, paths,
                                              kFSEventStreamEventIdSinceNow, LATENCY_S, CREATE_FLAGS)
                        : NULL;
  if (paths) {
    CFRelease(paths);
  }
  for (uint32_t i = 0; i < made; i++) {
    CFRelease(cf_paths[i]);
  }

  const char *failure = NULL;
  if (!watch->stream) {
    failure = "iclone_fsevents.start: FSEventStreamCreate returned NULL";
  } else {
    watch->events_queue = dispatch_queue_create("os.iclone.fsevents.events", DISPATCH_QUEUE_SERIAL);
    watch->control_queue = dispatch_queue_create("os.iclone.fsevents.control", DISPATCH_QUEUE_SERIAL);
    FSEventStreamSetDispatchQueue(watch->stream, watch->events_queue);
    if (!FSEventStreamStart(watch->stream)) {
      failure = "iclone_fsevents.start: FSEventStreamStart failed (fseventsd refused the stream)";
      FSEventStreamInvalidate(watch->stream);
    }
  }

  if (failure) {
    if (watch->stream) {
      FSEventStreamRelease(watch->stream);
      watch->stream = NULL;
    }
    if (watch->events_queue) {
      dispatch_release(watch->events_queue);
      dispatch_release(watch->control_queue);
    }
    watch->stopped = 1;
    napi_release_threadsafe_function(watch->tsfn, napi_tsfn_release);
    return throw_code(env, "EFSEVENTS", failure);
  }

  napi_value handle = NULL;
  if (napi_create_external(env, watch, handle_finalize, NULL, &handle) != napi_ok) {
    stop_watch(env, watch);
    return throw_code(env, "EFSEVENTS", "iclone_fsevents.start: cannot create the handle");
  }
  watch->refs += 1;
  return handle;
}

typedef struct FlushJob {
  Watch *watch;
  napi_deferred deferred;
} FlushJob;

/* On control_queue, so never concurrent with stop_on_control: the stream is alive here. */
static void flush_on_control(void *context) {
  FlushJob *job = context;
  Watch *watch = job->watch;
  if (watch->stream) {
    FSEventStreamFlushSync(watch->stream);
  }
  Item *item = calloc(1, sizeof *item);
  if (item) {
    item->kind = ITEM_FLUSHED;
    item->deferred = job->deferred;
    napi_call_threadsafe_function(watch->tsfn, item, napi_tsfn_nonblocking);
  }
  free(job);
}

static napi_value js_flush(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Watch *watch = argc ? unwrap(env, argv[0]) : NULL;
  if (!watch) {
    return throw_code(env, "EINVAL", "iclone_fsevents.flush: not a handle");
  }
  if (watch->stopped) {
    return throw_code(env, "ESTOPPED", "iclone_fsevents.flush: the stream is stopped");
  }

  FlushJob *job = calloc(1, sizeof *job);
  if (!job) {
    return throw_code(env, "ENOMEM", "iclone_fsevents.flush: out of memory");
  }
  napi_value promise = NULL;
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok) {
    free(job);
    return throw_code(env, "EFSEVENTS", "iclone_fsevents.flush: cannot create the promise");
  }
  job->watch = watch;
  if (watch->pending_flushes == 0) {
    napi_ref_threadsafe_function(env, watch->tsfn);
  }
  watch->pending_flushes += 1;
  dispatch_async_f(watch->control_queue, job, flush_on_control);
  return promise;
}

static napi_value js_latest_event_id(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Watch *watch = argc ? unwrap(env, argv[0]) : NULL;
  if (!watch) {
    return throw_code(env, "EINVAL", "iclone_fsevents.latestEventId: not a handle");
  }
  napi_value value = NULL;
  if (watch->stopped || !watch->stream) {
    napi_get_null(env, &value);
    return value;
  }
  /* Read on the JS thread while the stream is alive: stop_on_control releases it only after `stopped` is set here. */
  return id_string(env, (uint64_t)FSEventStreamGetLatestEventId(watch->stream));
}

static napi_value js_stop(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  Watch *watch = argc ? unwrap(env, argv[0]) : NULL;
  if (!watch) {
    return throw_code(env, "EINVAL", "iclone_fsevents.stop: not a handle");
  }
  stop_watch(env, watch);
  return NULL;
}

typedef struct VolumeJob {
  napi_async_work work;
  napi_deferred deferred;
  char path[PATH_MAX + 1];
  int error;
  char fstypename[MFSTYPENAMELEN];
  int local;
} VolumeJob;

static void volume_execute(napi_env env, void *data) {
  VolumeJob *job = data;
  struct statfs info;
  (void)env;
  if (statfs(job->path, &info) != 0) {
    job->error = errno;
    return;
  }
  memcpy(job->fstypename, info.f_fstypename, sizeof job->fstypename);
  job->fstypename[sizeof job->fstypename - 1] = '\0';
  job->local = (info.f_flags & MNT_LOCAL) != 0;
}

static void volume_complete(napi_env env, napi_status status, void *data) {
  VolumeJob *job = data;
  if (status != napi_ok || job->error) {
    napi_value message = NULL;
    napi_value error = NULL;
    napi_value code = NULL;
    napi_create_string_utf8(env, job->error ? strerror(job->error) : "statfs was cancelled", NAPI_AUTO_LENGTH, &message);
    napi_create_string_utf8(env, job->error == ENOENT ? "ENOENT" : "EFSEVENTS", NAPI_AUTO_LENGTH, &code);
    napi_create_error(env, code, message, &error);
    napi_reject_deferred(env, job->deferred, error);
  } else {
    napi_value result = NULL;
    napi_value name = NULL;
    napi_value local = NULL;
    napi_create_object(env, &result);
    napi_create_string_utf8(env, job->fstypename, NAPI_AUTO_LENGTH, &name);
    napi_get_boolean(env, job->local, &local);
    napi_set_named_property(env, result, "fstypename", name);
    napi_set_named_property(env, result, "local", local);
    napi_resolve_deferred(env, job->deferred, result);
  }
  napi_delete_async_work(env, job->work);
  free(job);
}

static napi_value js_volume(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(env, napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  VolumeJob *job = calloc(1, sizeof *job);
  if (!job) {
    return throw_code(env, "ENOMEM", "iclone_fsevents.volume: out of memory");
  }
  size_t length = 0;
  if (argc < 1 || napi_get_value_string_utf8(env, argv[0], job->path, sizeof job->path, &length) != napi_ok ||
      length == 0 || length >= PATH_MAX || job->path[0] != '/' || strlen(job->path) != length) {
    free(job);
    return throw_code(env, "EINVAL", "iclone_fsevents.volume: path must be an absolute path");
  }
  napi_value promise = NULL;
  napi_value name = NULL;
  napi_create_string_utf8(env, "iclone_fsevents.volume", NAPI_AUTO_LENGTH, &name);
  if (napi_create_promise(env, &job->deferred, &promise) != napi_ok ||
      napi_create_async_work(env, NULL, name, volume_execute, volume_complete, job, &job->work) != napi_ok ||
      napi_queue_async_work(env, job->work) != napi_ok) {
    free(job);
    return throw_code(env, "EFSEVENTS", "iclone_fsevents.volume: cannot queue the statfs");
  }
  return promise;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"currentEventId", NULL, js_current_event_id, NULL, NULL, NULL, napi_enumerable, NULL},
      {"start", NULL, js_start, NULL, NULL, NULL, napi_enumerable, NULL},
      {"flush", NULL, js_flush, NULL, NULL, NULL, napi_enumerable, NULL},
      {"latestEventId", NULL, js_latest_event_id, NULL, NULL, NULL, napi_enumerable, NULL},
      {"stop", NULL, js_stop, NULL, NULL, NULL, napi_enumerable, NULL},
      {"activeCount", NULL, js_active_count, NULL, NULL, NULL, napi_enumerable, NULL},
      {"testDropNextBatch", NULL, js_test_drop_next_batch, NULL, NULL, NULL, napi_enumerable, NULL},
      {"volume", NULL, js_volume, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  if (napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) != napi_ok) {
    return NULL;
  }
  return exports;
}

NAPI_MODULE(iclone_fsevents, init)
