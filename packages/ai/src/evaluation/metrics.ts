export interface Observation { expected: string; predicted: string; confidence?: number; accepted: boolean; validEvidence: boolean }
export interface ReliabilityBin { from: number; to: number; count: number; meanConfidence: number | null; accuracy: number | null }
export interface EvaluationMetrics {
  count: number; membershipAgreement: number; reviewRate: number; abstentionRate: number;
  selectiveAccuracy: number | null; acceptedCoverage: number; evidenceValidity: number;
  calibrationError: number | null; brierScore: number | null; reliability: ReliabilityBin[];
}
export function measure(observations: Observation[]): EvaluationMetrics {
  const count = observations.length;
  const accepted = observations.filter(item => item.accepted);
  // Abstention confidence is not a probability that the preserved baseline membership is correct.
  const scored = observations.filter(item => item.accepted && item.confidence !== undefined);
  const reliability = Array.from({ length: 5 }, (_, index) => {
    const from = index / 5; const to = (index + 1) / 5;
    const items = scored.filter(item => item.confidence! >= from && (index === 4 ? item.confidence! <= to : item.confidence! < to));
    return { from, to, count: items.length, meanConfidence: items.length ? items.reduce((sum, item) => sum + item.confidence!, 0) / items.length : null, accuracy: items.length ? items.filter(item => item.expected === item.predicted).length / items.length : null };
  });
  return {
    count, membershipAgreement: count ? observations.filter(item => item.expected === item.predicted).length / count : 0,
    reviewRate: count ? 1 - accepted.length / count : 0, abstentionRate: count ? observations.filter(item => !item.accepted).length / count : 0,
    selectiveAccuracy: accepted.length ? accepted.filter(item => item.expected === item.predicted).length / accepted.length : null,
    acceptedCoverage: count ? accepted.length / count : 0, evidenceValidity: count ? observations.filter(item => item.validEvidence).length / count : 0,
    calibrationError: scored.length ? reliability.reduce((sum, bin) => sum + (bin.count / scored.length) * Math.abs((bin.meanConfidence ?? 0) - (bin.accuracy ?? 0)), 0) : null,
    brierScore: scored.length ? scored.reduce((sum, item) => sum + (item.confidence! - Number(item.expected === item.predicted)) ** 2, 0) / scored.length : null,
    reliability,
  };
}
/** Tune only on the tuning split; maximize accepted coverage subject to the predeclared accuracy target. */
export function tuneThreshold(observations: Observation[], minimumSelectiveAccuracy = 0.9): number {
  for (const threshold of [0.5, 0.7, 0.8, 0.9, 0.95, 1]) {
    const accepted = observations.filter(item => item.confidence !== undefined && item.confidence >= threshold && item.validEvidence);
    if (accepted.length && accepted.filter(item => item.expected === item.predicted).length / accepted.length >= minimumSelectiveAccuracy) return threshold;
  }
  return 1;
}
