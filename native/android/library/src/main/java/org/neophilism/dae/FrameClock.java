package org.neophilism.dae;

/** One route's timestamp model. Discontinuities require explicit rejoin, not replay.
 * This is an estimated presentation timeline, not acoustic calibration. */
final class FrameClock {
    private final double period;
    private long previousRaw=-1, wraps=0, previousNanos=-1, previousWritten=-1;
    private double anchor=Double.NaN;
    FrameClock(int rate) {
        if(rate<8000||rate>192000)throw new IllegalArgumentException("INVALID_RATE");
        period=1000.0/rate;
    }
    double observe(long rawPosition,long timestampNanos,long written,double nowMs) {
        long raw=rawPosition&0xffffffffL;
        if(timestampNanos<0 || timestampNanos<previousNanos || written<previousWritten ||
           !Double.isFinite(nowMs) || Math.abs(timestampNanos/1_000_000.0-nowMs)>2000)
            throw new IllegalStateException("TIMESTAMP_DISCONTINUITY");
        long nextWraps=wraps;
        if(previousRaw>=0 && raw<previousRaw) {
            if(previousRaw-raw>0x80000000L)nextWraps+=1L<<32;
            else throw new IllegalStateException("FRAME_ROLLBACK");
        }
        long presented=nextWraps+raw;
        if(written<presented || written-presented>192000)throw new IllegalStateException("FRAME_RANGE_INVALID");
        double observedAnchor=timestampNanos/1_000_000.0-presented*period;
        if(Double.isNaN(anchor))anchor=observedAnchor;
        else if(Math.abs(observedAnchor-anchor)>10)throw new IllegalStateException("CLOCK_REJOIN_REQUIRED");
        wraps=nextWraps;previousRaw=raw;previousNanos=timestampNanos;previousWritten=written;
        return anchor+written*period;
    }
}
