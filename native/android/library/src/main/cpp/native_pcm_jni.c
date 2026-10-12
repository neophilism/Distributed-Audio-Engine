#include <jni.h>
#include <stdint.h>
#include "dae_pcm.h"
#define Q(value) ((dae_pcm_queue *)(intptr_t)(value))
#define FN(name) Java_org_neophilism_dae_NativePcm_##name

JNIEXPORT jlong JNICALL FN(nCreate)(JNIEnv *env,jclass cls,jint rate,jint channels) {
    (void)env;(void)cls;
    dae_pcm_config c={(uint32_t)rate,(uint32_t)channels,64,4u*1024u*1024u,1000};
    return (jlong)(intptr_t)dae_pcm_create(c);
}
JNIEXPORT void JNICALL FN(nDestroy)(JNIEnv *env,jclass cls,jlong handle) {
    (void)env;(void)cls;dae_pcm_destroy(Q(handle));
}
JNIEXPORT jint JNICALL FN(nActivate)(JNIEnv *env,jclass cls,jlong handle,jlong generation,jdouble now) {
    (void)env;(void)cls;
    if(generation<=0)return DAE_PCM_INVALID;
    return dae_pcm_activate(Q(handle),(uint64_t)generation,now);
}
JNIEXPORT void JNICALL FN(nDeactivate)(JNIEnv *env,jclass cls,jlong handle) {
    (void)env;(void)cls;dae_pcm_deactivate(Q(handle));
}
JNIEXPORT void JNICALL FN(nFault)(JNIEnv *env,jclass cls,jlong handle) {
    (void)env;(void)cls;dae_pcm_latch_fault(Q(handle));
}
JNIEXPORT jint JNICALL FN(nEnqueue)(JNIEnv *env,jclass cls,jlong handle,jlong token,jlong generation,
        jfloatArray samples,jdouble now,jdouble start,jdouble fade,jdouble stop,jfloat gain) {
    (void)cls;
    if(!handle||!samples||token<=0||generation<=0)return DAE_PCM_INVALID;
    jsize count=(*env)->GetArrayLength(env,samples);
    if(count<=0||count>4*1024*1024)return DAE_PCM_INVALID;
    jfloat *input=(*env)->GetFloatArrayElements(env,samples,NULL);
    if(!input)return DAE_PCM_LIMIT;
    dae_pcm_request r={(uint64_t)token,(uint64_t)generation,input,(size_t)count,now,start,fade,stop,gain};
    jint result=dae_pcm_enqueue(Q(handle),&r);
    (*env)->ReleaseFloatArrayElements(env,samples,input,JNI_ABORT);
    return result;
}
JNIEXPORT jint JNICALL FN(nUpdate)(JNIEnv *env,jclass cls,jlong handle,jlong generation,jlong token,jfloat gain,jdouble fade,jdouble stop) {
    (void)env;(void)cls;return dae_pcm_update(Q(handle),(uint64_t)generation,(uint64_t)token,gain,fade,stop);
}
JNIEXPORT jint JNICALL FN(nCancel)(JNIEnv *env,jclass cls,jlong handle,jlong generation,jlong token) {
    (void)env;(void)cls;return dae_pcm_cancel(Q(handle),(uint64_t)generation,(uint64_t)token);
}
JNIEXPORT void JNICALL FN(nCancelAll)(JNIEnv *env,jclass cls,jlong handle) {
    (void)env;(void)cls;dae_pcm_cancel_all(Q(handle));
}
JNIEXPORT jint JNICALL FN(nRender)(JNIEnv *env,jclass cls,jlong handle,jlong generation,jdouble start,jint frames,jobject output,jint channels) {
    (void)cls;
    if(!output||frames<1||frames>8192||channels<1||channels>8)return DAE_PCM_INVALID;
    jlong capacity=(*env)->GetDirectBufferCapacity(env,output);
    size_t count=(size_t)frames*(size_t)channels;
    if(capacity<0||(uint64_t)capacity<count*sizeof(float))return DAE_PCM_INVALID;
    float *buffer=(*env)->GetDirectBufferAddress(env,output);
    if(!buffer || ((uintptr_t)buffer % _Alignof(float)) != 0)return DAE_PCM_INVALID;
    return dae_pcm_render(Q(handle),(uint64_t)generation,start,(uint32_t)frames,buffer,count);
}
JNIEXPORT jlongArray JNICALL FN(nDrain)(JNIEnv *env,jclass cls,jlong handle) {
    (void)cls;uint64_t tokens[64];
    size_t count=dae_pcm_drain(Q(handle),tokens,64);jlong values[64];
    for(size_t i=0;i<count;++i)values[i]=(jlong)tokens[i];
    jlongArray result=(*env)->NewLongArray(env,(jsize)count);
    if(result && count)(*env)->SetLongArrayRegion(env,result,0,(jsize)count,values);
    return result;
}
JNIEXPORT jint JNICALL FN(nState)(JNIEnv *env,jclass cls,jlong handle) {
    (void)env;(void)cls;dae_pcm_snapshot s=dae_pcm_inspect(Q(handle));
    return (s.active?1:0)|(s.timing_fault?2:0);
}
