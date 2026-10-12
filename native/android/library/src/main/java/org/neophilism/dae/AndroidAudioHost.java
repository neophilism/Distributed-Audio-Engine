package org.neophilism.dae;

import android.app.Activity;
import android.app.Application;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRouting;
import android.media.AudioTimestamp;
import android.media.AudioTrack;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import java.lang.ref.WeakReference;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/** Foreground-only endpoint host. No microphone, network, pairing scan, or media persistence.
 * Every public control runs on the main thread. Application code must validate
 * signed authority and rights before enqueue, and explicitly rejoin after a stop. */
public final class AndroidAudioHost implements AutoCloseable {
    public static final class Route {
        public final String endpointId, routeId, outputId, kind;
        public final long generation;
        Route(String endpoint, String kind, long generation) {
            endpointId=endpoint; routeId=UUID.randomUUID().toString(); outputId=UUID.randomUUID().toString();
            this.kind=kind; this.generation=generation;
        }
    }
    public static final class Event {
        public final String type, reason, id;
        public final Route route;
        public final int sampleRate, maxChannels;
        private Event(String type, String reason, String id, Route route, int rate, int channels) {
            this.type=type; this.reason=reason; this.id=id; this.route=route; sampleRate=rate; maxChannels=channels;
        }
        static Event active(Route route,int rate,int channels) { return new Event("route-active",null,null,route,rate,channels); }
        static Event interrupted(String reason) { return new Event("interrupted",reason,null,null,0,0); }
        static Event completed(String id) { return new Event("completed",null,id,null,0,0); }
        static Event disconnected() { return new Event("disconnected",null,null,null,0,0); }
    }
    private static final int BLOCK_FRAMES=256;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final WeakReference<Activity> activity;
    private final Application application;
    private final AudioManager manager;
    private final String endpointId=UUID.randomUUID().toString();
    private long generation;
    private Consumer<Event> listener;
    private Session current;
    private boolean closed;

    private static final class Session {
        final AudioTrack track;
        final NativePcm pcm;
        final long generation;
        final AtomicLong revision=new AtomicLong();
        volatile boolean running=true, announced;
        volatile int routedId=-1;
        AudioFocusRequest focus;
        AudioRouting.OnRoutingChangedListener routing;
        Session(AudioTrack track,NativePcm pcm,long generation) { this.track=track;this.pcm=pcm;this.generation=generation; }
    }
    private final BroadcastReceiver noisy=new BroadcastReceiver() {
        @Override public void onReceive(Context context,Intent intent) {
            if(AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) interrupt(current,"becoming-noisy");
        }
    };
    private final Application.ActivityLifecycleCallbacks lifecycle=new Application.ActivityLifecycleCallbacks() {
        @Override public void onActivityPaused(Activity a) { if(a==activity.get()) interrupt(current,"app-suspended"); }
        @Override public void onActivityDestroyed(Activity a) { if(a==activity.get()) close(); }
        @Override public void onActivityCreated(Activity a,Bundle state) {}
        @Override public void onActivityStarted(Activity a) {}
        @Override public void onActivityResumed(Activity a) {}
        @Override public void onActivityStopped(Activity a) {}
        @Override public void onActivitySaveInstanceState(Activity a,Bundle state) {}
    };
    public AndroidAudioHost(Activity owner) {
        requireMain();
        activity=new WeakReference<>(owner); application=owner.getApplication();
        manager=(AudioManager)application.getSystemService(Context.AUDIO_SERVICE);
        if(manager==null)throw new IllegalStateException("AUDIO_MANAGER_UNAVAILABLE");
        IntentFilter filter=new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        if(Build.VERSION.SDK_INT>=33)application.registerReceiver(noisy,filter,Context.RECEIVER_NOT_EXPORTED);
        else application.registerReceiver(noisy,filter);
        application.registerActivityLifecycleCallbacks(lifecycle);
    }
    private static void requireMain() {
        if(Looper.myLooper()!=Looper.getMainLooper())throw new IllegalStateException("MAIN_THREAD_REQUIRED");
    }
    public static double nowMonotonicMs() { return System.nanoTime()/1_000_000.0; }
    private void emit(Event event) { if(listener!=null)listener.accept(event); }
    public Runnable subscribe(Consumer<Event> handler) {
        requireMain(); if(closed||listener!=null||handler==null)throw new IllegalStateException("SUBSCRIPTION_UNAVAILABLE");
        listener=handler;
        return () -> { requireMain(); stop(); listener=null; };
    }
    public void start() {
        requireMain(); Activity owner=activity.get();
        if(closed||listener==null||owner==null||owner.isFinishing()||owner.isDestroyed()||!owner.hasWindowFocus()||
           generation>=9_007_199_254_740_989L)throw new IllegalStateException("FOREGROUND_AUDIO_UNAVAILABLE");
        if(current!=null)stop();
        int rate=AudioTrack.getNativeOutputSampleRate(AudioManager.STREAM_MUSIC), channels=2;
        int minimum=AudioTrack.getMinBufferSize(rate,AudioFormat.CHANNEL_OUT_STEREO,AudioFormat.ENCODING_PCM_FLOAT);
        if(minimum<=0||minimum>8192*channels*4)throw new IllegalStateException("AUDIO_BUFFER_UNSUPPORTED");
        AudioAttributes attributes=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build();
        AudioTrack track=new AudioTrack.Builder().setAudioAttributes(attributes)
            .setAudioFormat(new AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                .setEncoding(AudioFormat.ENCODING_PCM_FLOAT).build())
            .setBufferSizeInBytes(Math.max(minimum,BLOCK_FRAMES*channels*4*2))
            .setTransferMode(AudioTrack.MODE_STREAM).setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY).build();
        NativePcm pcm=null;
        Session session=null;
        try {
            if(track.getState()!=AudioTrack.STATE_INITIALIZED||track.getSampleRate()!=rate)
                throw new IllegalStateException("AUDIO_TRACK_UNAVAILABLE");
            pcm=new NativePcm(rate,channels); session=new Session(track,pcm,++generation);
            final Session selected=session;
            session.focus=new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attributes).setWillPauseWhenDucked(true)
                .setOnAudioFocusChangeListener(change -> {
                    if(change!=AudioManager.AUDIOFOCUS_GAIN)interrupt(selected,"focus-loss");
                },main).build();
            current=session;
            if(manager.requestAudioFocus(session.focus)!=AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
                throw new IllegalStateException("AUDIO_FOCUS_DENIED");
            session.routing=routing -> {
                if(current!=selected||!selected.running)return;
                AudioDeviceInfo device=selected.track.getRoutedDevice();
                if(selected.announced&&(device==null||device.getId()!=selected.routedId))interrupt(selected,"becoming-noisy");
            };
            track.addOnRoutingChangedListener(session.routing,main);
            track.play();
            Thread worker=new Thread(() -> pump(selected),"DAE-AudioTrack");
            worker.setDaemon(true); worker.start();
            main.postDelayed(() -> poll(selected),20);
        } catch(RuntimeException error) {
            if(session!=null) {
                current=null; session.running=false; session.pcm.latchFault();
                if(session.focus!=null)manager.abandonAudioFocusRequest(session.focus);
                if(session.routing!=null)track.removeOnRoutingChangedListener(session.routing);
            }
            try { track.release(); } finally { if(pcm!=null)pcm.close(); }
            generation++; emit(Event.interrupted("service-destroyed")); throw error;
        }
    }
    private static String routeKind(AudioDeviceInfo device) {
        switch(device.getType()) {
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "internal";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_WIRED_HEADSET: return "headphones";
            default: return "unknown"; // Bluetooth class or name does not prove a speaker.
        }
    }
    private void pump(Session s) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
        int channels=s.pcm.channels, bytesPerFrame=channels*4;
        ByteBuffer block=ByteBuffer.allocateDirect(BLOCK_FRAMES*bytesPerFrame).order(ByteOrder.nativeOrder());
        AudioTimestamp stamp=new AudioTimestamp(); FrameClock clock=new FrameClock(s.pcm.sampleRate);
        long written=0; double started=nowMonotonicMs(); int underruns=s.track.getUnderrunCount();
        boolean activated=false;
        try {
            while(s.running) {
                double now=nowMonotonicMs();
                AudioDeviceInfo device=s.track.getRoutedDevice();
                if(s.announced&&(device==null||device.getId()!=s.routedId))throw new IllegalStateException("ROUTE_CHANGED");
                boolean timestamp=s.track.getTimestamp(stamp);
                double target=Double.NaN;
                if(timestamp)target=clock.observe(stamp.framePosition,stamp.nanoTime,written,now);
                if(!activated&&timestamp&&device!=null&&target>=now) {
                    s.pcm.activate(s.generation,now); activated=true; s.routedId=device.getId();
                    underruns=s.track.getUnderrunCount();
                    final Route route=new Route(endpointId,routeKind(device),s.generation);
                    main.post(() -> {
                        if(current==s&&s.running) { s.announced=true; emit(Event.active(route,s.pcm.sampleRate,s.pcm.channels)); }
                    });
                }
                if(activated&&(!timestamp||s.track.getUnderrunCount()>underruns))
                    throw new IllegalStateException("TIMELINE_REJOIN_REQUIRED");
                if(!activated&&now-started>3000)throw new IllegalStateException("TIMESTAMP_UNAVAILABLE");
                block.clear(); long revision=s.revision.get();
                if(activated) {
                    int status=s.pcm.render(s.generation,target,BLOCK_FRAMES,block);
                    if(status!=0&&status!=6)throw new IllegalStateException("RENDER_UNAVAILABLE");
                } else NativePcm.zero(block);
                double stalledAt=nowMonotonicMs();
                while(block.hasRemaining()&&s.running) {
                    if(revision!=s.revision.get()) { NativePcm.zero(block); revision=s.revision.get(); }
                    int count=s.track.write(block,block.remaining(),AudioTrack.WRITE_NON_BLOCKING);
                    if(count<0||count%bytesPerFrame!=0)throw new IllegalStateException("AUDIO_WRITE_FAILED");
                    if(count==0) {
                        if(nowMonotonicMs()-stalledAt>(activated?100:3000))throw new IllegalStateException("AUDIO_WRITE_STALLED");
                        Thread.sleep(1);
                    } else { written+=count/bytesPerFrame; stalledAt=nowMonotonicMs(); }
                }
                block.clear(); NativePcm.zero(block);
            }
        } catch(InterruptedException error) {
            Thread.currentThread().interrupt(); s.pcm.latchFault();
        } catch(RuntimeException error) {
            s.pcm.latchFault(); // Do not log PCM, IDs, device names or exception payloads.
        } finally {
            s.running=false; s.pcm.latchFault(); block.clear(); NativePcm.zero(block);
            try { s.track.pause(); s.track.flush(); } catch(IllegalStateException ignored) { }
            if(s.routing!=null)s.track.removeOnRoutingChangedListener(s.routing);
            s.track.release(); s.pcm.close();
            main.post(() -> interrupt(s,"service-destroyed"));
        }
    }
    private Session ready() {
        requireMain(); Session s=current;
        if(closed||s==null||!s.running||!s.announced)throw new IllegalStateException("AUDIO_OUTPUT_UNAVAILABLE");
        return s;
    }
    public void enqueue(NativePcm.Request request) { Session s=ready();s.pcm.enqueue(request,nowMonotonicMs()); }
    public void updateEnvelope(String id,float gain,double fade,double stop) {
        Session s=ready();s.revision.incrementAndGet();
        try { s.pcm.updateEnvelope(id,gain,fade,stop); } finally { s.revision.incrementAndGet(); }
    }
    public void cancel(String id) {
        Session s=ready();s.revision.incrementAndGet();
        try { s.pcm.cancel(id); } finally { s.revision.incrementAndGet(); }
    }
    public void cancelAll() {
        requireMain();Session s=current;
        if(s!=null&&s.running) {
            s.revision.incrementAndGet();
            try { s.pcm.cancelAll(); } finally { s.revision.incrementAndGet(); }
        }
    }
    private void poll(Session s) {
        if(current!=s||!s.running)return;
        if(s.announced) {
            if(!s.pcm.active()) { interrupt(s,"service-destroyed");return; }
            for(String id:s.pcm.drainCompleted())emit(Event.completed(id));
        }
        main.postDelayed(() -> poll(s),20);
    }
    private void shutdown(Session s) {
        if(s==null)return;
        s.running=false;s.revision.incrementAndGet();s.pcm.latchFault();
        if(s.focus!=null)manager.abandonAudioFocusRequest(s.focus);
        try { s.track.pause();s.track.flush(); } catch(IllegalStateException ignored) { }
        // Worker owns final release. Its try/finally keeps native lifetime bounded.
    }
    private void interrupt(Session expected,String reason) {
        requireMain();if(expected==null||current!=expected)return;
        current=null;shutdown(expected);generation++;emit(Event.interrupted(reason));
    }
    public void stop() {
        requireMain();if(closed)return;
        Session s=current;current=null;shutdown(s);generation++;emit(Event.disconnected());
    }
    @Override public void close() {
        requireMain();if(closed)return;
        stop();closed=true;listener=null;
        application.unregisterActivityLifecycleCallbacks(lifecycle);application.unregisterReceiver(noisy);
    }
}
