import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendTranscribedText,
  buildRecordedAudioBufferItem,
  isMicPermissionError,
  MIC_BLOCKED_MESSAGE,
  pickSupportedAudioMimeType,
  transcribeAudioClip,
} from './voiceInput';

test('pickSupportedAudioMimeType prefers audio/mp4 on Safari and audio/webm elsewhere', () => {
  const safariUa =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
  const chromeUa =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

  assert.equal(
    pickSupportedAudioMimeType((m) => m === 'audio/mp4' || m === 'audio/webm', safariUa),
    'audio/mp4'
  );
  assert.equal(
    pickSupportedAudioMimeType(
      (m) => m === 'audio/webm;codecs=opus' || m === 'audio/mp4',
      chromeUa
    ),
    'audio/webm;codecs=opus'
  );
});

test('buildRecordedAudioBufferItem builds audio buffer payload without fake fallback text', () => {
  const item = buildRecordedAudioBufferItem({
    base64Data: 'data:audio/webm;codecs=opus;base64,SGVsbG8=',
    mimeType: 'audio/webm;codecs=opus',
    durationSec: 5,
  });
  assert.equal(item.type, 'audio');
  assert.equal(item.mimeType, 'audio/webm');
  assert.equal(item.fileName, 'voice_note_5s.webm');
  assert.equal(item.base64Data, 'SGVsbG8=');
  assert.equal(item.textContent, undefined);
});

test('transcribeAudioClip sends inlineData to mocked model and cleans transcript', async () => {
  let capturedParts: any[] = [];
  const res = await transcribeAudioClip({
    audioBase64: 'data:audio/mp4;base64,QUJD',
    mimeType: 'audio/mp4',
    generate: async (parts) => {
      capturedParts = parts;
      return {
        text: '"शाम 6 बजे तक लॉन तैयार करना है"',
        modelUsed: 'gemini-flash-lite-latest',
      };
    },
  });

  assert.equal(res.text, 'शाम 6 बजे तक लॉन तैयार करना है');
  assert.equal(res.modelUsed, 'gemini-flash-lite-latest');
  assert.deepEqual(capturedParts[0], {
    inlineData: { mimeType: 'audio/mp4', data: 'QUJD' },
  });
  assert.match(capturedParts[1].text, /transcribe accurately/i);
});

test('isMicPermissionError catches browser permission errors for MIC_BLOCKED_MESSAGE', () => {
  assert.equal(isMicPermissionError({ name: 'NotAllowedError' }), true);
  assert.equal(isMicPermissionError({ name: 'PermissionDeniedError' }), true);
  assert.equal(isMicPermissionError({ message: 'Permission denied by user' }), true);
  assert.equal(isMicPermissionError({ name: 'NotFoundError', message: 'No device' }), false);
  assert.equal(
    MIC_BLOCKED_MESSAGE,
    'Microphone blocked — allow it in your browser, or type instead'
  );
});

test('appendTranscribedText appends spoken text without duplicating trailing phrase', () => {
  assert.equal(appendTranscribedText('', 'Check generator'), 'Check generator');
  assert.equal(appendTranscribedText('Lawn 2:', 'Check generator'), 'Lawn 2: Check generator');
  assert.equal(
    appendTranscribedText('Lawn 2: Check generator', 'check generator'),
    'Lawn 2: Check generator'
  );
});
