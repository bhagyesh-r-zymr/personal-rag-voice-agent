import { VOICE_STATES, stripCitationMarkers } from './voiceHelpers.js';

// Voice loop built on the browser's own speech recognition and speech synthesis.
// Used when Gemini Live is not available. Each recognized question goes through `ask`,
// which runs the normal /api/chat RAG flow and resolves with the answer text.
export function createBrowserVoice({ ask, onState }) {
  const voice = {
    active: false,
    state: VOICE_STATES.IDLE,
    recognition: null,
    recognitionHandled: false,
    stopRequested: false
  };

  function setState(state, detail = '') {
    voice.state = state;
    onState(state, detail);
  }

  function getSpeechRecognitionConstructor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function hasSpeechSynthesisSupport() {
    return 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance !== 'undefined';
  }

  function cancelSpeechOutput() {
    if (hasSpeechSynthesisSupport()) window.speechSynthesis.cancel();
  }

  function stopRecognition() {
    if (!voice.recognition) return;
    voice.stopRequested = true;
    voice.recognitionHandled = true;
    try {
      voice.recognition.abort();
    } catch (error) {
      // Ignore invalid abort attempts when recognition is already idle.
    }
  }

  function stop(detail = 'You can restart it whenever you are ready.') {
    voice.active = false;
    stopRecognition();
    cancelSpeechOutput();
    setState(VOICE_STATES.STOPPED, detail);
  }

  function speakText(text, state = VOICE_STATES.SPEAKING, detail = '') {
    const spokenText = stripCitationMarkers(text);
    if (!spokenText || !hasSpeechSynthesisSupport()) return Promise.resolve();

    cancelSpeechOutput();
    return new Promise((resolve) => {
      const utterance = new window.SpeechSynthesisUtterance(spokenText);
      utterance.lang = 'en-US';
      utterance.onstart = () => {
        if (voice.active) setState(state, detail);
      };
      utterance.onend = () => resolve();
      utterance.onerror = () => resolve();
      window.speechSynthesis.speak(utterance);
    });
  }

  async function reprompt(promptText, detail) {
    if (!voice.active) return;
    if (hasSpeechSynthesisSupport()) {
      await speakText(promptText, VOICE_STATES.SPEAKING, detail);
    } else {
      setState(VOICE_STATES.LISTENING, `${detail} Speech playback is unavailable, so follow the chat and keep speaking.`);
    }
    if (voice.active) startListening();
  }

  async function handleQuestion(transcript) {
    if (!voice.active) return;

    const answer = await ask(transcript);
    if (!voice.active) return;

    const spokenAnswer = stripCitationMarkers(answer) || "I couldn't find that in the company policies.";
    if (hasSpeechSynthesisSupport()) {
      await speakText(spokenAnswer, VOICE_STATES.SPEAKING, 'Speaking the policy answer.');
      if (!voice.active) return;
      await speakText('Do you have another policy question?', VOICE_STATES.SPEAKING, 'Prompting for another question.');
    } else {
      setState(VOICE_STATES.LISTENING, 'Speech playback is unavailable, so the answer is shown in chat.');
    }

    if (voice.active) startListening();
  }

  function ensureRecognition() {
    if (voice.recognition) return voice.recognition;

    const SpeechRecognition = getSpeechRecognitionConstructor();
    if (!SpeechRecognition) return null;

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.continuous = false;

    recognition.onstart = () => {
      if (voice.active) setState(VOICE_STATES.LISTENING);
    };

    recognition.onresult = (event) => {
      if (!voice.active || voice.recognitionHandled) return;
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript || '')
        .join(' ')
        .trim();
      if (!transcript) return;

      voice.recognitionHandled = true;
      setState(VOICE_STATES.PROCESSING);
      void handleQuestion(transcript);
    };

    recognition.onerror = (event) => {
      if (!voice.active || voice.stopRequested || voice.recognitionHandled) return;
      voice.recognitionHandled = true;

      if (event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stop('Microphone permission was denied. Use text chat or allow microphone access.');
        return;
      }
      if (event.error === 'audio-capture') {
        stop('No microphone was detected. Connect a microphone or use text chat.');
        return;
      }
      void reprompt("I didn't catch that. Please ask your policy question again.", 'Retrying after a microphone issue.');
    };

    recognition.onend = () => {
      if (!voice.active || voice.stopRequested) {
        voice.stopRequested = false;
        return;
      }
      if (voice.state === VOICE_STATES.LISTENING && !voice.recognitionHandled) {
        voice.recognitionHandled = true;
        void reprompt("I didn't hear anything. Please ask your policy question again.", 'Waiting for your question.');
      }
    };

    voice.recognition = recognition;
    return recognition;
  }

  function startListening() {
    if (!voice.active) return;
    const recognition = ensureRecognition();
    if (!recognition) {
      stop('Speech recognition is not supported in this browser. Use text chat instead.');
      return;
    }

    voice.recognitionHandled = false;
    voice.stopRequested = false;
    setState(VOICE_STATES.LISTENING);

    try {
      recognition.start();
    } catch (error) {
      if (!String(error?.message || '').toLowerCase().includes('already started')) {
        void reprompt('The microphone is busy. Please ask your policy question again.', 'Retrying after a microphone issue.');
      }
    }
  }

  async function start() {
    if (!getSpeechRecognitionConstructor()) {
      setState(VOICE_STATES.STOPPED, 'Speech recognition is not supported in this browser. Use text chat instead.');
      return;
    }

    voice.active = true;
    cancelSpeechOutput();
    setState(VOICE_STATES.GREETING, 'Starting the voice assistant.');
    await speakText('Hi, what would you like to know about company policy?', VOICE_STATES.GREETING, '');
    if (voice.active) startListening();
  }

  return {
    start,
    stop,
    isActive: () => voice.active
  };
}
