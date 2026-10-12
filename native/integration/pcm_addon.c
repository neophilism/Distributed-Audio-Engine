/* Test-only in-process JS/C integration adapter; not shipped in the npm package.
 * Exercises the same production PCM kernel linked by JNI and Swift, without an
 * audio device. No server, transport, private-key storage, or audio driver. */
#include <node_api.h>
#include "dae_pcm.h"
#include <math.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct { dae_pcm_queue *queue; uint32_t channels; } handle;
#define REQUIRE(x) do { if (!(x)) { napi_throw_error(env, NULL, "INVALID_NATIVE_TEST_ARGUMENT"); return NULL; } } while (0)
#define NAPI(x) REQUIRE((x) == napi_ok)
static void finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  handle *h = data; if (h) { dae_pcm_destroy(h->queue); free(h); }
}
static int number(napi_env env, napi_value value, double *out) {
  return napi_get_value_double(env, value, out) == napi_ok && isfinite(*out);
}
static int token(napi_env env, napi_value value, uint64_t *out) {
  bool lossless = false;
  return napi_get_value_bigint_uint64(env, value, out, &lossless) == napi_ok && lossless && *out;
}
static napi_value status(napi_env env, int code) {
  napi_value value; NAPI(napi_create_int32(env, code, &value)); return value;
}
static napi_value create(napi_env env, napi_callback_info info) {
  napi_value args[3], value; size_t count = 3; double rate, channels;
  NAPI(napi_get_cb_info(env, info, &count, args, NULL, NULL));
  REQUIRE(count == 2 && number(env, args[0], &rate) && number(env, args[1], &channels));
  REQUIRE(rate >= 8000 && rate <= 192000 && rate == floor(rate) &&
          channels >= 1 && channels <= 8 && channels == floor(channels));
  handle *h = calloc(1, sizeof(*h)); REQUIRE(h);
  h->channels = (uint32_t)channels;
  h->queue = dae_pcm_create((dae_pcm_config){ (uint32_t)rate, h->channels, 64, 4 * 1024 * 1024, 1000 });
  if (!h->queue) { free(h); napi_throw_error(env, NULL, "NATIVE_TEST_ALLOCATION_FAILED"); return NULL; }
  if (napi_create_external(env, h, finalize, NULL, &value) != napi_ok) {
    dae_pcm_destroy(h->queue); free(h); napi_throw_error(env, NULL, "NATIVE_TEST_HANDLE_FAILED"); return NULL;
  }
  return value;
}
enum { ACTIVATE = 1, ENQUEUE, UPDATE, CANCEL, CANCEL_ALL, DEACTIVATE, FAULT, RENDER, DRAIN, INSPECT, CLOSE };
static napi_value call(napi_env env, napi_callback_info info) {
  napi_value args[10], result; size_t count = 10; void *operation = NULL;
  NAPI(napi_get_cb_info(env, info, &count, args, NULL, &operation));
  REQUIRE(count >= 1); handle *h = NULL;
  NAPI(napi_get_value_external(env, args[0], (void **)&h)); REQUIRE(h);
  const int op = (int)(uintptr_t)operation;
  if (op == CLOSE) {
    REQUIRE(count == 1); dae_pcm_destroy(h->queue); h->queue = NULL; return status(env, 0);
  }
  REQUIRE(h->queue);
  uint64_t generation = 0, id = 0; double now = 0, start = 0, fade = 0, stop = 0, gain = 0;
  if (op == ACTIVATE) {
    REQUIRE(count == 3 && token(env, args[1], &generation) && number(env, args[2], &now));
    return status(env, dae_pcm_activate(h->queue, generation, now));
  }
  if (op == ENQUEUE) {
    REQUIRE(count == 9 && token(env, args[1], &id) && token(env, args[2], &generation));
    napi_typedarray_type type; size_t length = 0, offset = 0; void *samples = NULL; napi_value buffer;
    NAPI(napi_get_typedarray_info(env, args[3], &type, &length, &samples, &buffer, &offset));
    bool ordinary = false, detached = false;
    NAPI(napi_is_arraybuffer(env, buffer, &ordinary)); REQUIRE(ordinary);
    NAPI(napi_is_detached_arraybuffer(env, buffer, &detached)); REQUIRE(!detached);
    REQUIRE(type == napi_float32_array && length > 0 && length <= 4 * 1024 * 1024 && samples);
    REQUIRE(number(env, args[4], &now) && number(env, args[5], &start) &&
            number(env, args[6], &fade) && number(env, args[7], &stop) && number(env, args[8], &gain));
    REQUIRE(gain >= 0 && gain <= 1);
    dae_pcm_request request = { id, generation, samples, length, now, start, fade, stop, (float)gain };
    return status(env, dae_pcm_enqueue(h->queue, &request));
  }
  if (op == UPDATE) {
    REQUIRE(count == 6 && token(env, args[1], &generation) && token(env, args[2], &id));
    REQUIRE(number(env, args[3], &gain) && number(env, args[4], &fade) && number(env, args[5], &stop));
    REQUIRE(gain >= 0 && gain <= 1);
    return status(env, dae_pcm_update(h->queue, generation, id, (float)gain, fade, stop));
  }
  if (op == CANCEL) {
    REQUIRE(count == 3 && token(env, args[1], &generation) && token(env, args[2], &id));
    return status(env, dae_pcm_cancel(h->queue, generation, id));
  }
  if (op == RENDER) {
    double frames = 0;
    REQUIRE(count == 4 && token(env, args[1], &generation) && number(env, args[2], &start) && number(env, args[3], &frames));
    REQUIRE(frames >= 1 && frames <= 8192 && frames == floor(frames));
    const size_t length = (size_t)frames * h->channels;
    void *output = NULL; napi_value buffer, samples, code;
    NAPI(napi_create_arraybuffer(env, length * sizeof(float), &output, &buffer));
    int ret = dae_pcm_render(h->queue, generation, start, (uint32_t)frames, output, length);
    NAPI(napi_create_typedarray(env, napi_float32_array, length, buffer, 0, &samples));
    NAPI(napi_create_object(env, &result)); code = status(env, ret); REQUIRE(code);
    NAPI(napi_set_named_property(env, result, "status", code));
    NAPI(napi_set_named_property(env, result, "samples", samples)); return result;
  }
  REQUIRE(count == 1);
  if (op == CANCEL_ALL) { dae_pcm_cancel_all(h->queue); return status(env, 0); }
  if (op == DEACTIVATE) { dae_pcm_deactivate(h->queue); return status(env, 0); }
  if (op == FAULT) { dae_pcm_latch_fault(h->queue); return status(env, 0); }
  if (op == DRAIN) {
    uint64_t ids[64]; size_t n = dae_pcm_drain(h->queue, ids, 64);
    NAPI(napi_create_array_with_length(env, n, &result));
    for (size_t i = 0; i < n; i++) {
      napi_value value; NAPI(napi_create_bigint_uint64(env, ids[i], &value));
      NAPI(napi_set_element(env, result, (uint32_t)i, value));
    }
    return result;
  }
  if (op == INSPECT) {
    dae_pcm_snapshot s = dae_pcm_inspect(h->queue);
    NAPI(napi_create_object(env, &result));
    const char *names[] = { "samples", "voices", "active", "fault" };
    double values[] = { (double)s.queued_samples, s.occupied_voices, s.active, s.timing_fault };
    for (size_t i = 0; i < 4; i++) {
      napi_value value; NAPI(napi_create_double(env, values[i], &value));
      NAPI(napi_set_named_property(env, result, names[i], value));
    }
    return result;
  }
  REQUIRE(0);
}
static napi_value init(napi_env env, napi_value exports) {
  napi_value fn; NAPI(napi_create_function(env, "create", NAPI_AUTO_LENGTH, create, NULL, &fn));
  NAPI(napi_set_named_property(env, exports, "create", fn));
  const char *names[] = { "activate", "enqueue", "update", "cancel", "cancelAll", "deactivate", "fault", "render", "drain", "inspect", "close" };
  for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
    NAPI(napi_create_function(env, names[i], NAPI_AUTO_LENGTH, call, (void *)(uintptr_t)(i + 1), &fn));
    NAPI(napi_set_named_property(env, exports, names[i], fn));
  }
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
