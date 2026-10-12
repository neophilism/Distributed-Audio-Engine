package org.neophilism.dae;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.regex.Pattern;

/** Endpoint-only JNI queue. Controls must be authorized before calling this API. */
public final class NativePcm implements AutoCloseable {
    static { System.loadLibrary("dae_audio_jni"); }
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}");
    private final ReentrantReadWriteLock gate = new ReentrantReadWriteLock();
    private final HashMap<String, Long> tokens = new HashMap<>();
    private final HashMap<Long, String> ids = new HashMap<>();
    public final int sampleRate, channels;
    private long handle, generation, nextToken;
    private volatile boolean fault;

    public static final class Request {
        public final String id;
        public final long routeGeneration;
        public final float[] samples;
        public final int sampleRate, channels, frames;
        public final double startAtMonotonicMs, fadeStartMonotonicMs, stopAtMonotonicMs;
        public final float gainCeiling;
        public Request(String id, long generation, float[] samples, int rate, int channels, int frames,
                       double start, double fade, double stop, float gain) {
            this.id=id; routeGeneration=generation; this.samples=samples; sampleRate=rate;
            this.channels=channels; this.frames=frames; startAtMonotonicMs=start;
            fadeStartMonotonicMs=fade; stopAtMonotonicMs=stop; gainCeiling=gain;
        }
    }
    public NativePcm(int sampleRate, int channels) {
        this.sampleRate=sampleRate; this.channels=channels;
        handle=nCreate(sampleRate, channels);
        if (handle==0) throw new IllegalArgumentException("NATIVE_FORMAT_INVALID");
    }
    private void open() { if(handle==0) throw new IllegalStateException("NATIVE_QUEUE_CLOSED"); }
    private static void check(int status) {
        if(status!=0) throw new IllegalStateException("NATIVE_PCM_STATUS_"+status);
    }
    public void activate(long generation, double nowMs) {
        gate.writeLock().lock(); try {
            open(); check(nActivate(handle,generation,nowMs)); this.generation=generation;
            fault=false; tokens.clear(); ids.clear();
        } finally { gate.writeLock().unlock(); }
    }
    public void enqueue(Request r, double nowMs) {
        gate.writeLock().lock(); try {
            open();
            if(fault || r==null || r.id==null || !ID.matcher(r.id).matches() || r.samples==null ||
               r.sampleRate!=sampleRate || r.channels!=channels || r.frames<1 ||
               (long)r.frames*channels!=r.samples.length || r.samples.length>4*1024*1024 ||
               r.routeGeneration!=generation || tokens.containsKey(r.id) || nextToken==Long.MAX_VALUE)
                throw new IllegalArgumentException("NATIVE_REQUEST_INVALID");
            long token=++nextToken;
            check(nEnqueue(handle,token,generation,r.samples,nowMs,r.startAtMonotonicMs,
                           r.fadeStartMonotonicMs,r.stopAtMonotonicMs,r.gainCeiling));
            if(fault) { nDeactivate(handle); throw new IllegalStateException("NATIVE_QUEUE_FAULT"); }
            tokens.put(r.id,token); ids.put(token,r.id);
        } finally { gate.writeLock().unlock(); }
    }
    public void updateEnvelope(String id, float gain, double fade, double stop) {
        gate.writeLock().lock(); try {
            open(); if(fault) throw new IllegalStateException("NATIVE_QUEUE_FAULT");
            Long token=tokens.get(id); if(token!=null) check(nUpdate(handle,generation,token,gain,fade,stop));
        } finally { gate.writeLock().unlock(); }
    }
    public void cancel(String id) {
        gate.writeLock().lock(); try {
            open(); Long token=tokens.remove(id);
            if(token!=null) { ids.remove(token); check(nCancel(handle,generation,token)); }
        } finally { gate.writeLock().unlock(); }
    }
    public void cancelAll() {
        gate.writeLock().lock(); try { open(); nCancelAll(handle); tokens.clear(); ids.clear(); }
        finally { gate.writeLock().unlock(); }
    }
    public void deactivate() {
        fault=true;
        gate.writeLock().lock(); try { if(handle!=0)nDeactivate(handle); tokens.clear(); ids.clear(); }
        finally { gate.writeLock().unlock(); }
    }
    /** Non-waiting invalidation, including when an enqueue currently owns the gate. */
    public void latchFault() {
        fault=true;
        if(gate.readLock().tryLock()) {
            try { if(handle!=0)nFault(handle); } finally { gate.readLock().unlock(); }
        }
    }
    public boolean active() {
        gate.readLock().lock(); try { return handle!=0 && !fault && nState(handle)==1; }
        finally { gate.readLock().unlock(); }
    }
    public List<String> drainCompleted() {
        gate.writeLock().lock(); try {
            open(); List<String> result=new ArrayList<>();
            for(long token:nDrain(handle)) {
                String id=ids.remove(token); if(id!=null) { tokens.remove(id); result.add(id); }
            }
            return result;
        } finally { gate.writeLock().unlock(); }
    }
    static void zero(ByteBuffer buffer) {
        for(int i=buffer.position();i<buffer.limit();i++) buffer.put(i,(byte)0);
    }
    /** Direct native-order interleaved float output. Never waits on the control gate. */
    public int render(long generation, double startMs, int frames, ByteBuffer output) {
        if(output==null || !output.isDirect() || output.isReadOnly() || output.order()!=ByteOrder.nativeOrder() ||
           output.position()!=0 || frames<1 || frames>8192 || (long)frames*channels*4>output.limit())
            throw new IllegalArgumentException("NATIVE_OUTPUT_INVALID");
        if(!gate.readLock().tryLock()) { zero(output); return 6; }
        try {
            if(handle==0 || fault) { zero(output); return 5; }
            return nRender(handle,generation,startMs,frames,output,channels);
        } finally { gate.readLock().unlock(); }
    }
    @Override public void close() {
        fault=true;
        gate.writeLock().lock(); try {
            if(handle!=0) { nDestroy(handle); handle=0; }
            tokens.clear(); ids.clear();
        } finally { gate.writeLock().unlock(); }
    }
    private static native long nCreate(int rate,int channels);
    private static native void nDestroy(long handle);
    private static native int nActivate(long handle,long generation,double now);
    private static native void nDeactivate(long handle);
    private static native void nFault(long handle);
    private static native int nEnqueue(long handle,long token,long generation,float[] samples,double now,double start,double fade,double stop,float gain);
    private static native int nUpdate(long handle,long generation,long token,float gain,double fade,double stop);
    private static native int nCancel(long handle,long generation,long token);
    private static native void nCancelAll(long handle);
    private static native int nRender(long handle,long generation,double start,int frames,ByteBuffer output,int channels);
    private static native long[] nDrain(long handle);
    private static native int nState(long handle);
}
