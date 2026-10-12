package org.neophilism.dae;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicReference;

public final class NativePcmTest {
    static NativePcm.Request request(String id,long generation,float[] samples,double start,double stop) {
        return new NativePcm.Request(id,generation,samples,8000,1,samples.length,start,stop,stop,1);
    }
    static NativePcm queue() { NativePcm q=new NativePcm(8000,1);q.activate(1,1000);return q; }
    static ByteBuffer output(int frames) { return ByteBuffer.allocateDirect(frames*4).order(ByteOrder.nativeOrder()); }
    static void near(float actual,float expected) { assert Math.abs(actual-expected)<0.00001f : actual+" != "+expected; }
    static void rejects(Runnable call) { boolean rejected=false;try {call.run();}catch(IllegalArgumentException|IllegalStateException e){rejected=true;}assert rejected; }
    static void copiedAndStopped() {
        try(NativePcm q=queue()) {
            float[] samples=new float[8];Arrays.fill(samples,0.5f);q.enqueue(request("one",1,samples,1000,1001),1000);Arrays.fill(samples,0);
            ByteBuffer out=output(16);assert q.render(1,1000,16,out)==0;
            for(int i=0;i<16;i++)near(out.getFloat(i*4),i<8?0.5f:0);
            assert q.drainCompleted().equals(java.util.List.of("one"));assert q.drainCompleted().isEmpty();
        }
    }
    static void contractionAndOldIds() {
        try(NativePcm q=queue()) {
            float[] samples=new float[8];Arrays.fill(samples,1);q.enqueue(request("one",1,samples,1000,1001),1000);
            q.updateEnvelope("one",0.25f,1000.5,1000.75);q.updateEnvelope("one",1,2000,2000);
            ByteBuffer out=output(8);assert q.render(1,1000,8,out)==0;near(out.getFloat(0),0.25f);near(out.getFloat(24),0);
            assert q.drainCompleted().size()==1;q.enqueue(request("two",1,samples,1001,1002),1001);
            q.cancel("one");assert q.render(1,1001,8,out)==0;near(out.getFloat(0),1);
        }
    }
    static void invalidInputsAndBuffers() {
        try(NativePcm q=queue()) {
            rejects(() -> q.enqueue(request("bad/id",1,new float[8],1000,1001),1000));
            rejects(() -> q.enqueue(request("one",1,new float[]{Float.NaN},1000,1000.125),1000));
            rejects(() -> q.enqueue(new NativePcm.Request("one",1,new float[8],8000,1,7,1000,1001,1001,1),1000));
            rejects(() -> q.render(1,1000,8,ByteBuffer.allocate(32)));
            rejects(() -> q.render(1,1000,9,output(8)));
            ByteBuffer readonly=output(8).asReadOnlyBuffer();rejects(() -> q.render(1,1000,8,readonly));
        }
    }
    static void faultAndGeneration() {
        try(NativePcm q=queue()) {
            q.enqueue(request("one",1,new float[8],1000,1001),1000);q.latchFault();assert !q.active();
            ByteBuffer out=output(8);assert q.render(1,1000,8,out)==5;
            rejects(() -> q.enqueue(request("two",1,new float[8],1001,1002),1000));
            rejects(() -> q.activate(1,1000));q.activate(3,1000);assert q.active();
            rejects(() -> q.enqueue(request("one",1,new float[8],1000,1001),1000));
            assert q.render(1,1000,8,out)==5;assert q.render(3,1000,8,out)==0;
        }
    }
    static void closedLifetime() throws Exception {
        NativePcm q=queue();AtomicReference<Throwable> failure=new AtomicReference<>();
        Thread worker=new Thread(() -> {
            try { ByteBuffer out=output(8);for(int i=0;i<20000;i++) {
                int s=q.render(1,1000+i,8,out);assert s==0||s==5||s==6;
            }}catch(Throwable e){failure.set(e);}
        });
        worker.start();q.close();q.close();worker.join();if(failure.get()!=null)throw new AssertionError(failure.get());
        rejects(() -> q.enqueue(request("one",1,new float[8],1000,1001),1000));
    }
    static void clockContinuity() {
        FrameClock clock=new FrameClock(8000);near((float)clock.observe(0,1_000_000_000L,80,1000),1010);
        near((float)clock.observe(8,1_001_000_000L,88,1001),1011);
        rejects(() -> clock.observe(7,1_002_000_000L,90,1002));
        rejects(() -> clock.observe(16,1_100_000_000L,96,1100));
        rejects(() -> new FrameClock(8000).observe(0,1_000_000_000L,0,5000));
    }
    static void clockWrap() {
        FrameClock clock=new FrameClock(8000);long frames=0xfffffff8L;
        double first=clock.observe(frames,1_000_000_000L,frames+16,1000);
        double next=clock.observe(0,1_001_000_000L,(1L<<32)+16,1001);
        assert Math.abs((next-first)-1)<0.0001;
    }
    public static void main(String[] args) throws Exception {
        copiedAndStopped();contractionAndOldIds();invalidInputsAndBuffers();faultAndGeneration();closedLifetime();clockContinuity();clockWrap();
        System.out.println("Android JNI: 7 contract cases passed, including concurrent close and timestamp wrap");
    }
}
