#ifndef DAE_PCM_H
#define DAE_PCM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Endpoint-only volatile PCM. This API performs no authorization or key exchange.
 * Calls require previously verified authority and the active route generation.
 * Times use the platform monotonic/host clock in milliseconds, never Unix time.
 * Destroy must not race any API call. Render never allocates or waits on a lock. */
typedef struct dae_pcm_queue dae_pcm_queue;
typedef enum {
  DAE_PCM_OK = 0,
  DAE_PCM_INVALID = 1,
  DAE_PCM_STALE = 2,
  DAE_PCM_LIMIT = 3,
  DAE_PCM_CONFLICT = 4,
  DAE_PCM_UNAVAILABLE = 5,
  DAE_PCM_BUSY = 6
} dae_pcm_status;

typedef struct {
  uint32_t sample_rate;
  uint32_t channels;
  uint32_t max_voices;
  uint32_t max_samples;
  double horizon_ms;
} dae_pcm_config;

typedef struct {
  uint64_t token;
  uint64_t generation;
  const float *samples;
  size_t sample_count;
  double now_ms;
  double starts_at_ms;
  double fade_start_ms;
  double stops_at_ms;
  float gain_ceiling;
} dae_pcm_request;

typedef struct {
  uint64_t generation;
  size_t queued_samples;
  uint32_t occupied_voices;
  int active;
  int timing_fault;
  double rendered_until_ms;
} dae_pcm_snapshot;

dae_pcm_queue *dae_pcm_create(dae_pcm_config config);
void dae_pcm_destroy(dae_pcm_queue *queue);
dae_pcm_status dae_pcm_activate(dae_pcm_queue *queue, uint64_t generation, double now_ms);
void dae_pcm_deactivate(dae_pcm_queue *queue);
dae_pcm_status dae_pcm_enqueue(dae_pcm_queue *queue, const dae_pcm_request *request);
/* Contraction only: no update can increase gain, postpone a fade, or extend output. */
dae_pcm_status dae_pcm_update(dae_pcm_queue *queue, uint64_t generation, uint64_t token,
                             float gain_ceiling, double fade_start_ms, double stops_at_ms);
dae_pcm_status dae_pcm_cancel(dae_pcm_queue *queue, uint64_t generation, uint64_t token);
void dae_pcm_cancel_all(dae_pcm_queue *queue);
/* Interleaved float PCM. All writable output is zeroed on a rejected render.
 * start_ms denotes the estimated presentation time of the first output frame.
 * A stale callback cannot consume a newer generation. Overlapping/backwards
 * callbacks latch a timing fault until a new generation is explicitly activated. */
dae_pcm_status dae_pcm_render(dae_pcm_queue *queue, uint64_t generation, double start_ms,
                             uint32_t frames, float *output, size_t output_capacity);
/* Control-thread completion drain; frees and wipes completed PCM, never in render. */
size_t dae_pcm_drain(dae_pcm_queue *queue, uint64_t *tokens, size_t capacity);
dae_pcm_snapshot dae_pcm_inspect(dae_pcm_queue *queue);

#ifdef __cplusplus
}
#endif
#endif
