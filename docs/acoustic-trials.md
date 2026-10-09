# Acoustic feasibility harness

Use a short operator-controlled reference capture to estimate delay and compare actual measured trial reports against a preregistered policy. The current portable harness calculates normalized correlation, sample lag, latency, p95/worst skew, dropout fraction and evidence gaps. It does not upload ambient audio and does not reinterpret digital waveform amplitude as calibrated dBA.

Real trials require an actual active Bluetooth route, a calibrated external reference instrument or validated microphone configuration, a documented measurement position/method, source attribution, and captured-data digests. Test repetitions must include route changes and interruptions. The policy is set before the capture; do not tune limits to make an observed failure pass.

Synthetic tests validate the harness mathematics. Captured numerical results are candidates for qualified review; this module deliberately does not authenticate the reference instrument or sign its own hardware certificate. No physical measurements were performed as part of development. Native capture integration and independent field validation remain outstanding.
