import {expect, test} from 'bun:test';
import {reportAutomationCorrelation} from './report-automation';

test('automation correlation preserves exact bounded IDs and rejects malformed or extra fields', () => {
  const correlation = {alertId: 'exact-alert_1:2', testRunId: 'exact-run'};
  expect(reportAutomationCorrelation(correlation)).toEqual(correlation);
  for (const input of [null, [], {}, {...correlation, alertId: 'bad/id'}, {...correlation, alertId: 'a'.repeat(161)},
    {...correlation, testRunId: ' '}, {...correlation, testRunId: 'r'.repeat(161)}, {...correlation, credential: 'private'}])
    expect(reportAutomationCorrelation(input)).toBeNull();
});
