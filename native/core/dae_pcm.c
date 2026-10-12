#include "dae_pcm.h"

#include <math.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

#define DAE_MAX_VOICES 64u
#define DAE_MAX_SAMPLES (16u * 1024u * 1024u)
#define DAE_MAX_RENDER_FRAMES 8192u
#define DAE_MAX_TIME_MS 1000000000000.0

typedef struct {
  uint64_t token;
  float *samples;
  size_t count;
  double start;
  double fade;
  double stop;
  float gain;
  int done;
} dae_voice;

struct dae_pcm_queue {
  dae_pcm_config config;
  pthread_mutex_t mutex;
  dae_voice voices[DAE_MAX_VOICES];
  uint64_t generation;
  size_t samples;
  double control_time;
  double rendered_until;
  int active;
  int timing_fault;
};

static int valid_time(double value) {
  return isfinite(value) && value >= 0.0 && value <= DAE_MAX_TIME_MS;
}

/* Volatile writes are intentional: do not optimize away plaintext cleanup. */
static void erase(void *data, size_t bytes) {
  volatile unsigned char *p = (volatile unsigned char *)data;
  while (bytes--) *p++ = 0;
}

static void release_voice(dae_pcm_queue *q, dae_voice *v) {
  if (v->samples) {
    erase(v->samples, v->count * sizeof(float));
    free(v->samples);
    q->samples -= v->count;
  }
  memset(v, 0, sizeof(*v));
}

static void clear_locked(dae_pcm_queue *q) {
  for (uint32_t i = 0; i < q->config.max_voices; ++i) release_voice(q, &q->voices[i]);
}

static dae_voice *find_voice(dae_pcm_queue *q, uint64_t token) {
  for (uint32_t i = 0; i < q->config.max_voices; ++i)
    if (q->voices[i].token == token) return &q->voices[i];
  return NULL;
}

dae_pcm_queue *dae_pcm_create(dae_pcm_config config) {
  if (config.sample_rate < 8000 || config.sample_rate > 192000 ||
      config.channels < 1 || config.channels > 8 ||
      config.max_voices < 1 || config.max_voices > DAE_MAX_VOICES ||
      config.max_samples < 1 || config.max_samples > DAE_MAX_SAMPLES ||
      !isfinite(config.horizon_ms) || config.horizon_ms < 1 || config.horizon_ms > 5000)
    return NULL;
  dae_pcm_queue *q = (dae_pcm_queue *)calloc(1, sizeof(*q));
  if (!q) return NULL;
  q->config = config;
  if (pthread_mutex_init(&q->mutex, NULL) != 0) { free(q); return NULL; }
  return q;
}

void dae_pcm_destroy(dae_pcm_queue *q) {
  if (!q) return;
  pthread_mutex_lock(&q->mutex);
  clear_locked(q);
  pthread_mutex_unlock(&q->mutex);
  pthread_mutex_destroy(&q->mutex);
  erase(q, sizeof(*q));
  free(q);
}

dae_pcm_status dae_pcm_activate(dae_pcm_queue *q, uint64_t generation, double now_ms) {
  if (!q || generation == 0 || !valid_time(now_ms)) return DAE_PCM_INVALID;
  pthread_mutex_lock(&q->mutex);
  if (generation <= q->generation || now_ms < q->control_time) {
    pthread_mutex_unlock(&q->mutex); return DAE_PCM_STALE;
  }
  clear_locked(q);
  q->generation = generation;
  q->control_time = now_ms;
  q->rendered_until = now_ms;
  q->timing_fault = 0;
  q->active = 1;
  pthread_mutex_unlock(&q->mutex);
  return DAE_PCM_OK;
}

void dae_pcm_deactivate(dae_pcm_queue *q) {
  if (!q) return;
  pthread_mutex_lock(&q->mutex);
  q->active = 0;
  clear_locked(q);
  pthread_mutex_unlock(&q->mutex);
}

dae_pcm_status dae_pcm_enqueue(dae_pcm_queue *q, const dae_pcm_request *r) {
  if (!q || !r || !r->samples || !r->token || !r->generation || !r->sample_count ||
      r->sample_count > q->config.max_samples || r->sample_count % q->config.channels ||
      !valid_time(r->now_ms) || !valid_time(r->starts_at_ms) ||
      !valid_time(r->fade_start_ms) || !valid_time(r->stops_at_ms) ||
      !isfinite(r->gain_ceiling) || r->gain_ceiling < 0 || r->gain_ceiling > 1 ||
      r->starts_at_ms < r->now_ms || r->stops_at_ms <= r->starts_at_ms ||
      r->stops_at_ms - r->now_ms > q->config.horizon_ms ||
      r->starts_at_ms - r->now_ms > q->config.horizon_ms)
    return DAE_PCM_INVALID;
  const size_t frames = r->sample_count / q->config.channels;
  const double end = r->starts_at_ms + (double)frames * 1000.0 / q->config.sample_rate;
  /* Permit only floating-point roundoff, not an extra frame of authority. */
  if (r->stops_at_ms > end + 0.000001) return DAE_PCM_INVALID;
  for (size_t i = 0; i < r->sample_count; ++i)
    if (!isfinite(r->samples[i]) || r->samples[i] < -1.0f || r->samples[i] > 1.0f)
      return DAE_PCM_INVALID;
  pthread_mutex_lock(&q->mutex);
  dae_pcm_status status = DAE_PCM_OK;
  dae_voice *slot = NULL;
  if (!q->active) status = DAE_PCM_UNAVAILABLE;
  else if (r->generation != q->generation || r->now_ms < q->control_time ||
           r->starts_at_ms + 0.000001 < q->rendered_until) status = DAE_PCM_STALE;
  else if (r->sample_count > q->config.max_samples - q->samples) status = DAE_PCM_LIMIT;
  else {
    for (uint32_t i = 0; i < q->config.max_voices; ++i) {
      dae_voice *v = &q->voices[i];
      if (!v->token) { if (!slot) slot = v; continue; }
      if (v->token == r->token || (!v->done && r->starts_at_ms < v->stop && r->stops_at_ms > v->start)) {
        status = DAE_PCM_CONFLICT; break;
      }
    }
    if (status == DAE_PCM_OK && !slot) status = DAE_PCM_LIMIT;
  }
  if (status == DAE_PCM_OK) {
    float *copy = (float *)malloc(r->sample_count * sizeof(float));
    if (!copy) status = DAE_PCM_LIMIT;
    else {
      memcpy(copy, r->samples, r->sample_count * sizeof(float));
      /* Validate the owned snapshot, too: caller memory may change during copy. */
      for (size_t i = 0; i < r->sample_count; ++i) {
        if (!isfinite(copy[i]) || copy[i] < -1.0f || copy[i] > 1.0f) {
          erase(copy, r->sample_count * sizeof(float)); free(copy);
          pthread_mutex_unlock(&q->mutex); return DAE_PCM_INVALID;
        }
      }
      *slot = (dae_voice){r->token, copy, r->sample_count, r->starts_at_ms,
                          fmin(r->fade_start_ms, r->stops_at_ms), r->stops_at_ms,
                          r->gain_ceiling, 0};
      q->samples += r->sample_count;
      q->control_time = r->now_ms;
    }
  }
  pthread_mutex_unlock(&q->mutex);
  return status;
}

dae_pcm_status dae_pcm_update(dae_pcm_queue *q, uint64_t generation, uint64_t token,
                             float gain, double fade, double stop) {
  if (!q || !generation || !token || !isfinite(gain) || gain < 0 || gain > 1 ||
      !valid_time(fade) || !valid_time(stop)) return DAE_PCM_INVALID;
  pthread_mutex_lock(&q->mutex);
  dae_pcm_status status = DAE_PCM_OK;
  if (!q->active) status = DAE_PCM_UNAVAILABLE;
  else if (generation != q->generation) status = DAE_PCM_STALE;
  else {
    dae_voice *v = find_voice(q, token);
    if (!v) status = DAE_PCM_STALE;
    else {
      v->gain = fminf(v->gain, gain);
      v->stop = fmin(v->stop, stop);
      v->fade = fmin(v->fade, fmin(fade, v->stop));
      if (v->stop <= v->start || v->gain == 0) v->done = 1;
    }
  }
  pthread_mutex_unlock(&q->mutex);
  return status;
}

dae_pcm_status dae_pcm_cancel(dae_pcm_queue *q, uint64_t generation, uint64_t token) {
  if (!q || !generation || !token) return DAE_PCM_INVALID;
  pthread_mutex_lock(&q->mutex);
  dae_pcm_status status = DAE_PCM_OK;
  if (generation != q->generation) status = DAE_PCM_STALE;
  else { dae_voice *v = find_voice(q, token); if (v) release_voice(q, v); }
  pthread_mutex_unlock(&q->mutex);
  return status;
}

void dae_pcm_cancel_all(dae_pcm_queue *q) {
  if (!q) return;
  pthread_mutex_lock(&q->mutex);
  clear_locked(q);
  pthread_mutex_unlock(&q->mutex);
}

dae_pcm_status dae_pcm_render(dae_pcm_queue *q, uint64_t generation, double start,
                             uint32_t frames, float *out, size_t capacity) {
  if (!out) return DAE_PCM_INVALID;
  /* Never accept absurd byte counts at this C ABI. Platform wrappers also check
   * real buffer capacities before entering native code. */
  if (capacity > DAE_MAX_RENDER_FRAMES * 8u) return DAE_PCM_INVALID;
  memset(out, 0, capacity * sizeof(float));
  if (!q || !frames || frames > DAE_MAX_RENDER_FRAMES ||
      capacity < (size_t)frames * q->config.channels || !valid_time(start)) return DAE_PCM_INVALID;
  const double period = 1000.0 / q->config.sample_rate;
  const double end = start + (double)frames * period;
  if (!valid_time(end)) return DAE_PCM_INVALID;
  if (pthread_mutex_trylock(&q->mutex) != 0) return DAE_PCM_BUSY;
  if (!q->active || generation != q->generation) {
    pthread_mutex_unlock(&q->mutex); return DAE_PCM_UNAVAILABLE;
  }
  /* One quarter sample tolerates timestamp conversion roundoff, not replay. */
  if (start + period * 0.25 < q->rendered_until) {
    q->active = 0; q->timing_fault = 1;
    pthread_mutex_unlock(&q->mutex); return DAE_PCM_STALE;
  }
  q->rendered_until = end;
  for (uint32_t i = 0; i < q->config.max_voices; ++i) {
    dae_voice *v = &q->voices[i];
    if (!v->token || v->done || v->start >= end) continue;
    if (v->stop <= start) { v->done = 1; continue; }
    for (uint32_t frame = 0; frame < frames; ++frame) {
      const double at = start + (double)frame * period;
      if (at < v->start || at >= v->stop) continue;
      const size_t source_frame = (size_t)floor((at - v->start) / period + 0.0000001);
      if (source_frame >= v->count / q->config.channels) continue;
      double gain = v->gain;
      if (at >= v->fade && v->stop > v->fade)
        gain *= fmax(0.0, (v->stop - at) / (v->stop - v->fade));
      for (uint32_t channel = 0; channel < q->config.channels; ++channel)
        out[(size_t)frame * q->config.channels + channel] =
          v->samples[source_frame * q->config.channels + channel] * (float)gain;
    }
    if (end >= v->stop) v->done = 1;
  }
  pthread_mutex_unlock(&q->mutex);
  return DAE_PCM_OK;
}

size_t dae_pcm_drain(dae_pcm_queue *q, uint64_t *tokens, size_t capacity) {
  if (!q || !tokens || capacity > DAE_MAX_VOICES) return 0;
  pthread_mutex_lock(&q->mutex);
  size_t count = 0;
  for (uint32_t i = 0; i < q->config.max_voices && count < capacity; ++i) {
    dae_voice *v = &q->voices[i];
    if (v->token && v->done) { tokens[count++] = v->token; release_voice(q, v); }
  }
  pthread_mutex_unlock(&q->mutex);
  return count;
}

dae_pcm_snapshot dae_pcm_inspect(dae_pcm_queue *q) {
  dae_pcm_snapshot result = {0};
  if (!q) return result;
  pthread_mutex_lock(&q->mutex);
  result.generation = q->generation;
  result.queued_samples = q->samples;
  result.active = q->active;
  result.timing_fault = q->timing_fault;
  result.rendered_until_ms = q->rendered_until;
  for (uint32_t i = 0; i < q->config.max_voices; ++i)
    if (q->voices[i].token) ++result.occupied_voices;
  pthread_mutex_unlock(&q->mutex);
  return result;
}
