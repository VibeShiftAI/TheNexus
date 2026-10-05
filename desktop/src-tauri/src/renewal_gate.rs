//! Shared native admission gate: completion, not request arrival, starts cooldown.
use std::time::{Duration, Instant};
use std::sync::Mutex;

pub const RENEW_COOLDOWN: Duration = Duration::from_secs(30);
pub const BUSY_RETRY: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct RenewalGate {
    running: bool,
    completed: Option<Instant>,
}

impl RenewalGate {
    pub fn begin(&mut self, now: Instant) -> Result<(), Duration> {
        if self.running { return Err(BUSY_RETRY); }
        if let Some(at) = self.completed {
            let remaining = RENEW_COOLDOWN.saturating_sub(now.duration_since(at));
            if !remaining.is_zero() { return Err(remaining); }
        }
        self.running = true;
        Ok(())
    }
    pub fn finish(&mut self, now: Instant) {
        self.running = false;
        self.completed = Some(now);
    }
    pub fn due(&self, now: Instant, cadence: Duration) -> bool {
        !self.running && self.completed.map_or(true, |at| now.duration_since(at) >= cadence)
    }
}

/// Owns an admitted exchange without holding the mutex during network I/O.
/// Unwinding releases admission just like an ordinary exchange completion.
pub struct RenewalAttempt<'a>(&'a Mutex<RenewalGate>);

impl<'a> RenewalAttempt<'a> {
    pub fn begin(gate: &'a Mutex<RenewalGate>, now: Instant) -> Result<Self, Duration> {
        gate.lock().unwrap().begin(now)?;
        Ok(Self(gate))
    }
}

impl Drop for RenewalAttempt<'_> {
    fn drop(&mut self) {
        // Never cause a second panic while unwinding an exchange.
        self.0.lock().unwrap_or_else(|error| error.into_inner()).finish(Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slow_exchange_cannot_overlap_and_failure_gets_a_real_retry_after_cooldown() {
        let mut gate = RenewalGate::default();
        let start = Instant::now();
        assert!(gate.begin(start).is_ok());
        assert_eq!(gate.begin(start + Duration::from_secs(45)), Err(BUSY_RETRY));
        gate.finish(start + Duration::from_secs(45)); // transient failure
        assert_eq!(gate.begin(start + Duration::from_secs(47)), Err(Duration::from_secs(28)));
        assert!(gate.begin(start + Duration::from_secs(75)).is_ok());
        gate.finish(start + Duration::from_secs(76));
        assert!(!gate.due(start + Duration::from_secs(76), Duration::from_secs(8 * 3600)));
    }
    #[test]
    fn running_exchange_is_never_due_even_after_the_schedule_cadence() {
        let mut gate = RenewalGate::default();
        let start = Instant::now();
        let cadence = Duration::from_secs(8 * 3600);
        assert!(gate.due(start, cadence));
        assert!(gate.begin(start).is_ok());
        assert!(!gate.due(start + cadence * 2, cadence));
    }

    #[test]
    fn panicking_exchange_releases_gate_without_poisoning_it() {
        let gate = std::sync::Mutex::new(RenewalGate::default());
        let outcome = std::panic::catch_unwind(|| {
            let _attempt = RenewalAttempt::begin(&gate, Instant::now()).unwrap();
            panic!("simulated exchange panic");
        });
        assert!(outcome.is_err());
        assert!(!gate.is_poisoned());
        assert!(gate.lock().unwrap().begin(Instant::now() + RENEW_COOLDOWN).is_ok());
    }

}
