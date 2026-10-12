#include "dae_pcm.h"
#include <assert.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>

static dae_pcm_queue *make_queue(uint32_t channels, uint32_t max_samples, uint32_t max_voices) {
  dae_pcm_config c = {8000, channels, max_voices, max_samples, 1000};
  dae_pcm_queue *q = dae_pcm_create(c); assert(q);
  assert(dae_pcm_activate(q, 1, 1000) == DAE_PCM_OK);
  return q;
}
static dae_pcm_request request(float *samples, size_t count, uint64_t token, double start, double stop) {
  dae_pcm_request r = {token, 1, samples, count, 1000, start, stop, stop, 1}; return r;
}
static void silent(const float *out, size_t count) { for (size_t i=0;i<count;++i) assert(out[i] == 0); }
static void near(float value, float expected) { assert(fabsf(value - expected) < 0.00001f); }

static void copied_timeline_and_completion(void) {
  dae_pcm_queue *q = make_queue(2, 64, 4);
  float input[] = {1,-1,0.5f,-0.5f,0.25f,-0.25f,0.1f,-0.1f};
  dae_pcm_request r = request(input, 8, 1, 1000.25, 1000.75);
  assert(dae_pcm_enqueue(q, &r) == DAE_PCM_OK);
  for (unsigned i=0;i<8;++i) input[i]=0;
  float out[16]; assert(dae_pcm_render(q,1,1000,8,out,16)==DAE_PCM_OK);
  near(out[0],0); near(out[4],1); near(out[5],-1); near(out[6],0.5f); near(out[10],0.1f); near(out[12],0);
  uint64_t ids[4]; assert(dae_pcm_drain(q,ids,4)==1 && ids[0]==1);
  assert(dae_pcm_inspect(q).queued_samples==0);
  assert(dae_pcm_drain(q,ids,4)==0); dae_pcm_destroy(q);
}
static void fade_and_hard_deadline(void) {
  dae_pcm_queue *q=make_queue(1,64,4); float input[16]; for(unsigned i=0;i<16;++i)input[i]=1;
  dae_pcm_request r=request(input,16,1,1000,1002); r.fade_start_ms=1001; r.gain_ceiling=0.5f;
  assert(dae_pcm_enqueue(q,&r)==DAE_PCM_OK);
  float out[24]; assert(dae_pcm_render(q,1,1000,24,out,24)==DAE_PCM_OK);
  near(out[0],0.5f); near(out[8],0.5f); near(out[12],0.25f); near(out[15],0.0625f); silent(out+16,8);
  dae_pcm_destroy(q);
}
static void envelope_only_contracts(void) {
  dae_pcm_queue *q=make_queue(1,64,4); float input[16];for(unsigned i=0;i<16;++i)input[i]=1;
  dae_pcm_request r=request(input,16,1,1000,1002); assert(dae_pcm_enqueue(q,&r)==DAE_PCM_OK);
  assert(dae_pcm_update(q,1,1,0.5f,1000.5,1001)==DAE_PCM_OK);
  assert(dae_pcm_update(q,1,1,1,2000,2000)==DAE_PCM_OK);
  float out[16]; assert(dae_pcm_render(q,1,1000,16,out,16)==DAE_PCM_OK);
  near(out[0],0.5f); near(out[6],0.25f); silent(out+8,8); dae_pcm_destroy(q);
}
static void stale_generations_and_callbacks(void) {
  dae_pcm_queue *q=make_queue(1,64,4);float in[8]={1};dae_pcm_request r=request(in,8,1,1001,1002);
  assert(dae_pcm_enqueue(q,&r)==DAE_PCM_OK);dae_pcm_deactivate(q);
  assert(dae_pcm_inspect(q).queued_samples==0);assert(dae_pcm_activate(q,1,1000)==DAE_PCM_STALE);
  assert(dae_pcm_activate(q,3,1000)==DAE_PCM_OK);assert(dae_pcm_enqueue(q,&r)==DAE_PCM_STALE);
  r.generation=3;assert(dae_pcm_enqueue(q,&r)==DAE_PCM_OK);
  assert(dae_pcm_cancel(q,1,1)==DAE_PCM_STALE);assert(dae_pcm_update(q,1,1,0,0,0)==DAE_PCM_STALE);
  float out[8];assert(dae_pcm_render(q,1,1001,8,out,8)==DAE_PCM_UNAVAILABLE);silent(out,8);
  assert(dae_pcm_render(q,3,1001,8,out,8)==DAE_PCM_OK);near(out[0],1);dae_pcm_destroy(q);
}
static void callback_rollback_latches_silence(void) {
  dae_pcm_queue *q=make_queue(1,64,4);float out[8];
  assert(dae_pcm_render(q,1,1000,8,out,8)==DAE_PCM_OK);
  assert(dae_pcm_render(q,1,1000.5,8,out,8)==DAE_PCM_STALE);silent(out,8);
  assert(dae_pcm_inspect(q).timing_fault==1);
  assert(dae_pcm_render(q,1,1002,8,out,8)==DAE_PCM_UNAVAILABLE);
  assert(dae_pcm_activate(q,2,1002)==DAE_PCM_OK);assert(dae_pcm_inspect(q).timing_fault==0);dae_pcm_destroy(q);
}
static void late_callbacks_never_replay(void) {
  dae_pcm_queue *q=make_queue(1,64,4);float in[16];for(unsigned i=0;i<16;++i)in[i]=(float)i/16;
  dae_pcm_request r=request(in,16,1,1000,1002);assert(dae_pcm_enqueue(q,&r)==DAE_PCM_OK);
  float out[8];assert(dae_pcm_render(q,1,1001,8,out,8)==DAE_PCM_OK);near(out[0],0.5f);near(out[7],0.9375f);
  assert(dae_pcm_render(q,1,1004,8,out,8)==DAE_PCM_OK);silent(out,8);dae_pcm_destroy(q);
}
static void input_validation_is_atomic(void) {
  dae_pcm_queue *q=make_queue(1,64,4);float in[8]={0};dae_pcm_request r=request(in,8,1,1000,1001);
  in[0]=NAN;assert(dae_pcm_enqueue(q,&r)==DAE_PCM_INVALID);in[0]=INFINITY;assert(dae_pcm_enqueue(q,&r)==DAE_PCM_INVALID);
  in[0]=1.1f;assert(dae_pcm_enqueue(q,&r)==DAE_PCM_INVALID);in[0]=1;
  r.stops_at_ms=NAN;assert(dae_pcm_enqueue(q,&r)==DAE_PCM_INVALID);r.stops_at_ms=1002;assert(dae_pcm_enqueue(q,&r)==DAE_PCM_INVALID);
  r.stops_at_ms=1001;r.gain_ceiling=-1;assert(dae_pcm_enqueue(q,&r)==DAE_PCM_INVALID);r.gain_ceiling=1;
  r.now_ms=999;assert(dae_pcm_enqueue(q,&r)==DAE_PCM_STALE);r.now_ms=1000;
  assert(dae_pcm_inspect(q).occupied_voices==0);assert(dae_pcm_enqueue(q,&r)==DAE_PCM_OK);
  assert(dae_pcm_update(q,1,1,NAN,0,0)==DAE_PCM_INVALID);
  float out[8];assert(dae_pcm_render(q,1,1000,8,out,8)==DAE_PCM_OK);near(out[0],1);dae_pcm_destroy(q);
}
static void queue_limits_duplicates_and_overlap(void) {
  dae_pcm_queue *q=make_queue(1,16,2);float in[8]={0};dae_pcm_request a=request(in,8,1,1000,1001);
  assert(dae_pcm_enqueue(q,&a)==DAE_PCM_OK);assert(dae_pcm_enqueue(q,&a)==DAE_PCM_CONFLICT);
  dae_pcm_request b=request(in,8,2,1000.5,1001.5);assert(dae_pcm_enqueue(q,&b)==DAE_PCM_CONFLICT);
  b.starts_at_ms=1001;b.stops_at_ms=1002;assert(dae_pcm_enqueue(q,&b)==DAE_PCM_OK);
  dae_pcm_request c=request(in,8,3,1002,1003);assert(dae_pcm_enqueue(q,&c)==DAE_PCM_LIMIT);
  assert(dae_pcm_cancel(q,1,1)==DAE_PCM_OK);assert(dae_pcm_enqueue(q,&c)==DAE_PCM_OK);
  dae_pcm_cancel_all(q);assert(dae_pcm_inspect(q).queued_samples==0);dae_pcm_destroy(q);
}
static void invalid_configuration_and_render(void) {
  dae_pcm_config c={8000,1,4,64,1000};c.channels=0;assert(!dae_pcm_create(c));c.channels=1;c.max_voices=65;assert(!dae_pcm_create(c));
  c.max_voices=4;c.horizon_ms=NAN;assert(!dae_pcm_create(c));
  dae_pcm_queue *q=make_queue(1,64,4);float out[8];for(unsigned i=0;i<8;++i)out[i]=1;
  assert(dae_pcm_render(q,1,NAN,8,out,8)==DAE_PCM_INVALID);silent(out,8);
  assert(dae_pcm_render(q,1,1000,9,out,8)==DAE_PCM_INVALID);silent(out,8);dae_pcm_destroy(q);
}
static void zero_gain_and_expired_voice_completion(void) {
  dae_pcm_queue *q=make_queue(1,64,4);float in[8]={1};dae_pcm_request r=request(in,8,1,1000,1001);
  assert(dae_pcm_enqueue(q,&r)==DAE_PCM_OK);assert(dae_pcm_update(q,1,1,0,1000,1001)==DAE_PCM_OK);
  float out[8];assert(dae_pcm_render(q,1,1000,8,out,8)==DAE_PCM_OK);silent(out,8);
  uint64_t ids[1];assert(dae_pcm_drain(q,ids,1)==1);r.token=2;r.starts_at_ms=1001;r.stops_at_ms=1002;
  assert(dae_pcm_enqueue(q,&r)==DAE_PCM_OK);assert(dae_pcm_render(q,1,1004,8,out,8)==DAE_PCM_OK);silent(out,8);
  assert(dae_pcm_drain(q,ids,1)==1 && ids[0]==2);dae_pcm_destroy(q);
}
static void rendered_past_cannot_be_enqueued(void) {
  dae_pcm_queue *q=make_queue(1,64,4);float out[8];assert(dae_pcm_render(q,1,1000,8,out,8)==DAE_PCM_OK);
  float in[8]={1};dae_pcm_request r=request(in,8,1,1000,1001);assert(dae_pcm_enqueue(q,&r)==DAE_PCM_STALE);dae_pcm_destroy(q);
}
static void *concurrent_control(void *arg) {
  dae_pcm_queue *q=(dae_pcm_queue *)arg;
  for(unsigned i=0;i<20000;++i) {dae_pcm_cancel_all(q);(void)dae_pcm_inspect(q);}
  return NULL;
}
static void concurrent_render_never_blocks_or_leaks(void) {
  dae_pcm_queue *q=make_queue(1,64,4);pthread_t thread;assert(pthread_create(&thread,NULL,concurrent_control,q)==0);
  float out[8];for(unsigned i=0;i<20000;++i) {dae_pcm_status s=dae_pcm_render(q,1,1000+i,8,out,8);assert(s==DAE_PCM_OK||s==DAE_PCM_BUSY);silent(out,8);}
  assert(pthread_join(thread,NULL)==0);dae_pcm_destroy(q);
}
static void seeded_adversarial_sequences(void) {
  uint32_t rng=0x9e3779b9u;float in[8]={0.5f};float out[8];
  dae_pcm_queue *q=make_queue(1,64,4);
  for(unsigned i=0;i<10000;++i) {
    rng=rng*1664525u+1013904223u;double now=1000+(double)i*2;
    dae_pcm_cancel_all(q);
    dae_pcm_request r=request(in,8,(uint64_t)i+1,now,now+1);r.now_ms=now;
    if(rng&1)r.gain_ceiling=NAN;
    dae_pcm_status s=dae_pcm_enqueue(q,&r);assert(s==DAE_PCM_OK||s==DAE_PCM_INVALID);
    assert(dae_pcm_render(q,1,now,8,out,8)==DAE_PCM_OK);
    for(unsigned j=0;j<8;++j)assert(isfinite(out[j])&&fabsf(out[j])<=0.5f);
  }
  dae_pcm_destroy(q);
}
int main(void) {
  void (*tests[])(void)={copied_timeline_and_completion,fade_and_hard_deadline,envelope_only_contracts,
    stale_generations_and_callbacks,callback_rollback_latches_silence,late_callbacks_never_replay,
    input_validation_is_atomic,queue_limits_duplicates_and_overlap,invalid_configuration_and_render,
    zero_gain_and_expired_voice_completion,rendered_past_cannot_be_enqueued,
    concurrent_render_never_blocks_or_leaks,seeded_adversarial_sequences};
  for(size_t i=0;i<sizeof(tests)/sizeof(tests[0]);++i)tests[i]();
  printf("native PCM: %zu contract cases passed (including 10000 adversarial sequences)\n",sizeof(tests)/sizeof(tests[0]));return 0;
}
