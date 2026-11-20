import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRecognitionEvent,
  buildAccumulatedTranscript,
  createVoiceSessionAccumulator,
  formatVoiceFinalText,
  type SpeechRecognitionEventSlice,
} from './useVoiceRecorder';

test('single spoken word ("yesterday") with interim updates never repeats in final output', () => {
  let acc = createVoiceSessionAccumulator('Call client');

  // Interim updates replace interimText while committed final text stays unchanged
  const stream: SpeechRecognitionEventSlice[] = [
    { resultIndex: 0, results: [{ isFinal: false, transcript: 'yes' }] },
    { resultIndex: 0, results: [{ isFinal: false, transcript: 'yester' }] },
    { resultIndex: 0, results: [{ isFinal: false, transcript: 'yesterday' }] },
  ];

  for (const evt of stream) {
    acc = applyRecognitionEvent(acc, evt);
    assert.equal(formatVoiceFinalText(acc), 'Call client');
  }
  assert.equal(acc.interimText, 'yesterday');

  // Finalization commits "yesterday" once and clears interimText
  acc = applyRecognitionEvent(acc, {
    resultIndex: 0,
    results: [{ isFinal: true, transcript: 'yesterday' }],
  });
  assert.equal(acc.interimText, '');
  assert.equal(formatVoiceFinalText(acc), 'Call client yesterday');
});

test('continuous-mode duplicate & cumulative final emissions do not repeat words', () => {
  let acc = createVoiceSessionAccumulator('');

  // Emits slot 0..4 with Chrome mobile-style repeated/cumulative finals across advancing resultIndex
  const events: SpeechRecognitionEventSlice[] = [
    {
      resultIndex: 0,
      results: [{ isFinal: true, transcript: 'yesterday' }],
    },
    {
      resultIndex: 1,
      results: [
        { isFinal: true, transcript: 'yesterday' },
        { isFinal: true, transcript: 'yesterday' },
      ],
    },
    {
      resultIndex: 2,
      results: [
        { isFinal: true, transcript: 'yesterday' },
        { isFinal: true, transcript: 'yesterday' },
        { isFinal: true, transcript: 'yesterday deliver 40 jars' },
      ],
    },
    {
      resultIndex: 3,
      results: [
        { isFinal: true, transcript: 'yesterday' },
        { isFinal: true, transcript: 'yesterday' },
        { isFinal: true, transcript: 'yesterday deliver 40 jars' },
        { isFinal: false, transcript: 'to Sunrise' },
      ],
    },
  ];

  for (const evt of events) {
    acc = applyRecognitionEvent(acc, evt);
  }

  assert.equal(formatVoiceFinalText(acc), 'yesterday deliver 40 jars');
  assert.equal(acc.interimText, 'to Sunrise');

  // Next final chunk at resultIndex 3 commits cleanly once
  acc = applyRecognitionEvent(acc, {
    resultIndex: 3,
    results: [
      { isFinal: true, transcript: 'yesterday' },
      { isFinal: true, transcript: 'yesterday' },
      { isFinal: true, transcript: 'yesterday deliver 40 jars' },
      { isFinal: true, transcript: 'to Sunrise IT Park' },
    ],
  });

  assert.equal(acc.interimText, '');
  assert.equal(formatVoiceFinalText(acc), 'yesterday deliver 40 jars to Sunrise IT Park');
});

test('multi-chunk dictation preserves earlier finalized segments when resultIndex advances', () => {
  let acc = createVoiceSessionAccumulator('Urgent:');

  acc = applyRecognitionEvent(acc, {
    resultIndex: 0,
    results: [{ isFinal: true, transcript: 'Fix the dispenser' }],
  });
  assert.equal(formatVoiceFinalText(acc), 'Urgent: Fix the dispenser');

  acc = applyRecognitionEvent(acc, {
    resultIndex: 1,
    results: [
      { isFinal: true, transcript: 'Fix the dispenser' },
      { isFinal: false, transcript: 'at Greenleaf' },
    ],
  });
  // Unfinished second chunk must NOT be added to committed final message
  assert.equal(formatVoiceFinalText(acc), 'Urgent: Fix the dispenser');
  assert.equal(acc.interimText, 'at Greenleaf');

  acc = applyRecognitionEvent(acc, {
    resultIndex: 1,
    results: [
      { isFinal: true, transcript: 'Fix the dispenser' },
      { isFinal: true, transcript: 'at Greenleaf Office' },
    ],
  });
  assert.equal(acc.interimText, '');
  assert.equal(formatVoiceFinalText(acc), 'Urgent: Fix the dispenser at Greenleaf Office');
});

test('buildAccumulatedTranscript handles empty baseText and whitespace-only interim cleanly', () => {
  assert.equal(
    buildAccumulatedTranscript('', [{ isFinal: true, transcript: 'Deliver 20 jars' }]),
    'Deliver 20 jars'
  );
  assert.equal(buildAccumulatedTranscript('Existing notes', []), 'Existing notes');
  assert.equal(
    buildAccumulatedTranscript('Existing notes', [{ isFinal: false, transcript: '   ' }]),
    'Existing notes'
  );
});
