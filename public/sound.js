(function (root, factory) {
  const soundApi = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = soundApi;
  } else {
    root.CoupSound = soundApi.create(root);
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  const ENABLED_KEY = 'coup-sound-enabled';
  const VOLUME_KEY = 'coup-sound-volume';
  const MASTER_LEVEL = 0.4;
  const MAX_ACTIVE_VOICES = 8;
  const SOUND_PATTERNS = {
    ui: [{ frequency: 740, duration: 0.09, type: 'sine' }],
    cardCast: [{ frequency: 410, duration: 0.11, type: 'triangle' }, { frequency: 300, delay: 0.055, duration: 0.12, type: 'sine' }],
    challenge: [{ frequency: 300, duration: 0.12, type: 'triangle' }, { frequency: 390, delay: 0.09, duration: 0.13, type: 'sine' }],
    counter: [{ frequency: 500, duration: 0.09, type: 'triangle' }, { frequency: 370, delay: 0.075, duration: 0.12, type: 'sine' }],
    success: [{ frequency: 520, duration: 0.13 }, { frequency: 660, delay: 0.08, duration: 0.14 }, { frequency: 790, delay: 0.16, duration: 0.18 }],
    failure: [{ frequency: 310, duration: 0.14, type: 'triangle' }, { frequency: 205, delay: 0.1, duration: 0.2, type: 'sine' }],
    loss: [{ frequency: 245, duration: 0.16, type: 'triangle' }, { frequency: 175, delay: 0.1, duration: 0.18, type: 'sine' }],
    elimination: [{ frequency: 150, duration: 0.22, type: 'sawtooth' }, { frequency: 95, delay: 0.12, duration: 0.28, type: 'sine' }],
    turn: [{ frequency: 570, duration: 0.1, type: 'sine' }],
    gameStart: [{ frequency: 392, duration: 0.16 }, { frequency: 494, delay: 0.1, duration: 0.16 }, { frequency: 587, delay: 0.2, duration: 0.22 }],
    gameEnd: [{ frequency: 523, duration: 0.16 }, { frequency: 659, delay: 0.1, duration: 0.16 }, { frequency: 784, delay: 0.2, duration: 0.16 }, { frequency: 988, delay: 0.3, duration: 0.28 }]
  };

  function create(rootObject) {
    let enabled = readEnabled();
    let volume = readVolume();
    let context = null;
    let masterGain = null;
    let resumePromise = null;
    let activeVoices = 0;
    let lastError = null;
    let lastSound = { type: 'none', at: null };
    const playedEvents = new Map();

    function errorText(error) {
      return error?.message || String(error || 'Unknown Web Audio error');
    }

    function recordError(error, prefix = '') {
      lastError = `${prefix}${errorText(error)}`;
      return false;
    }

    function getAudioContextClass() {
      if (typeof rootObject.AudioContext === 'function') return rootObject.AudioContext;
      if (typeof rootObject.webkitAudioContext === 'function') return rootObject.webkitAudioContext;
      return null;
    }

    function storageGet(key) {
      try {
        return rootObject.localStorage.getItem(key);
      } catch {
        return null;
      }
    }

    function storageSet(key, value) {
      try {
        rootObject.localStorage.setItem(key, value);
      } catch {
        // Audio remains usable when browser storage is unavailable.
      }
    }

    function readEnabled() {
      const stored = storageGet(ENABLED_KEY);
      if (stored === 'true' || stored === 'false') return stored === 'true';
      if (stored !== null) storageSet(ENABLED_KEY, 'true');
      return true;
    }

    function readVolume() {
      const stored = storageGet(VOLUME_KEY);
      if (stored === null || stored.trim() === '') return 0.65;
      const parsed = Number(stored);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
      storageSet(VOLUME_KEY, '0.65');
      return 0.65;
    }

    function updateMasterGain() {
      if (!masterGain || !context) return;
      try {
        const target = enabled && volume > 0 ? Math.max(0.0001, Math.min(1, volume)) * MASTER_LEVEL : 0;
        const parameter = masterGain.gain;
        if (typeof parameter.setTargetAtTime === 'function') {
          parameter.setTargetAtTime(target, context.currentTime, 0.015);
        } else if (typeof parameter.setValueAtTime === 'function') {
          parameter.setValueAtTime(target, context.currentTime);
        } else {
          parameter.value = target;
        }
      } catch (error) {
        recordError(error, 'Master gain update failed: ');
      }
    }

    function ensureContext() {
      if (context && context.state !== 'closed') return context;
      context = null;
      masterGain = null;
      const AudioContextClass = getAudioContextClass();
      if (!AudioContextClass) {
        recordError('AudioContext and webkitAudioContext are unavailable');
        return null;
      }
      try {
        context = new AudioContextClass();
        if (!context.destination) throw new Error('AudioContext destination is unavailable');
        masterGain = context.createGain();
        masterGain.connect(context.destination);
        updateMasterGain();
        return context;
      } catch (error) {
        recordError(error, 'AudioContext setup failed: ');
        context = null;
        masterGain = null;
        return null;
      }
    }

    function resumeContext() {
      if (!context) return Promise.resolve(false);
      if (context.state === 'running') return Promise.resolve(true);
      if (resumePromise) return resumePromise;
      try {
        resumePromise = Promise.resolve(context.resume())
          .then(() => {
            if (context.state === 'running') {
              lastError = null;
              return true;
            }
            return recordError(`AudioContext.resume() resolved in state "${context.state}"`);
          })
          .catch(error => recordError(error, 'AudioContext.resume() failed: '))
          .finally(() => { resumePromise = null; });
        return resumePromise;
      } catch (error) {
        resumePromise = null;
        return Promise.resolve(recordError(error, 'AudioContext.resume() failed: '));
      }
    }

    function unlockAudio() {
      if (!ensureContext()) return Promise.resolve(false);
      return resumeContext();
    }

    function onUserGesture() {
      return unlockAudio();
    }

    for (const eventName of ['pointerdown', 'touchstart', 'click', 'keydown']) {
      if (typeof rootObject.addEventListener === 'function') {
        rootObject.addEventListener(eventName, onUserGesture, { capture: true, passive: true });
      }
    }

    function hasPlayedEvent(eventId) {
      return Boolean(eventId && playedEvents.has(eventId));
    }

    function rememberEvent(eventId) {
      if (!eventId) return;
      const now = Date.now();
      playedEvents.set(eventId, now);
      if (playedEvents.size > 256) {
        const oldest = playedEvents.keys().next().value;
        playedEvents.delete(oldest);
      }
      return true;
    }

    function schedule(pattern, options = {}) {
      if (!context || (!options.allowSuspended && context.state !== 'running') || !masterGain || !context.destination) {
        return recordError('Audio output is not ready');
      }
      const now = context.currentTime;
      const notes = pattern.filter(note => note.frequency > 0).slice(0, MAX_ACTIVE_VOICES - activeVoices);
      if (!notes.length) return recordError('Maximum overlapping sound voices reached');

      try {
        for (const note of notes) {
          const oscillator = context.createOscillator();
          const envelope = context.createGain();
          const startAt = now + (note.delay || 0);
          const endAt = startAt + note.duration;
          oscillator.type = note.type || 'sine';
          oscillator.frequency.setValueAtTime(note.frequency, startAt);
          envelope.gain.setValueAtTime(0.0001, startAt);
          envelope.gain.exponentialRampToValueAtTime(options.peak || 0.8, startAt + 0.018);
          envelope.gain.exponentialRampToValueAtTime(0.0001, endAt);
          oscillator.connect(envelope);
          envelope.connect(masterGain);
          activeVoices += 1;
          let released = false;
          const releaseVoice = () => {
            if (released) return;
            released = true;
            activeVoices = Math.max(0, activeVoices - 1);
          };
          oscillator.onended = releaseVoice;
          oscillator.start(startAt);
          oscillator.stop(endAt + 0.01);
          if (options.onVoice) options.onVoice(oscillator, envelope, releaseVoice);
        }
        lastError = null;
        return true;
      } catch (error) {
        recordError(error, 'Audio graph failed: ');
        return false;
      }
    }

    async function play(name, eventId) {
      if (!enabled || volume <= 0 || !SOUND_PATTERNS[name] || hasPlayedEvent(eventId)) return false;
      if (!context) return recordError('AudioContext has not been unlocked by a user gesture');
      if (context.state !== 'running' && !await resumeContext()) return false;
      if (context.state !== 'running') return false;
      updateMasterGain();
      const didSchedule = schedule(SOUND_PATTERNS[name]);
      if (didSchedule) {
        rememberEvent(eventId);
        lastSound = { type: name, at: new Date().toISOString() };
      }
      return didSchedule;
    }

    function testSound() {
      lastSound = { type: 'test 600 Hz', at: new Date().toISOString() };
      if (!enabled) {
        recordError('Sound is OFF. Turn sound on before testing.');
        return Promise.resolve(false);
      }
      if (volume <= 0) {
        recordError('Volume is 0%. Raise the master volume before testing.');
        return Promise.resolve(false);
      }

      // Run context creation, resume(), graph construction and start() in the click stack.
      const audioContext = ensureContext();
      if (!audioContext) return Promise.resolve(false);
      const unlockResult = unlockAudio();

      const voiceNodes = [];
      const didSchedule = schedule([{ frequency: 600, duration: 0.2, type: 'sine' }], {
        allowSuspended: true,
        peak: 0.9,
        onVoice: (oscillator, envelope, releaseVoice) => voiceNodes.push({ oscillator, envelope, releaseVoice })
      });
      if (!didSchedule) return Promise.resolve(false);

      return Promise.resolve(unlockResult).then(unlocked => {
        if (!unlocked || audioContext.state !== 'running') {
          for (const voice of voiceNodes) {
            try { voice.oscillator.stop(); } catch {}
            voice.releaseVoice();
          }
          if (!lastError) recordError(`Test Sound could not start output; AudioContext is "${audioContext.state}"`);
          return false;
        }
        lastError = null;
        return true;
      }).catch(error => {
        for (const voice of voiceNodes) {
          try { voice.oscillator.stop(); } catch {}
          voice.releaseVoice();
        }
        return recordError(error, 'Test Sound resume failed: ');
      });
    }

    function setEnabled(value) {
      enabled = Boolean(value);
      storageSet(ENABLED_KEY, String(enabled));
      updateMasterGain();
      return enabled;
    }

    function setVolume(value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return volume;
      volume = Math.min(1, Math.max(0, parsed));
      storageSet(VOLUME_KEY, String(volume));
      updateMasterGain();
      return volume;
    }

    function getState() {
      const AudioContextClass = getAudioContextClass();
      return {
        enabled,
        volume,
        contextState: context ? context.state : 'uninitialized',
        supported: Boolean(AudioContextClass),
        api: !AudioContextClass ? 'unavailable' : (AudioContextClass === rootObject.AudioContext ? 'AudioContext' : 'webkitAudioContext'),
        outputAvailable: Boolean(context?.destination),
        lastSound: { ...lastSound },
        lastError
      };
    }

    return { unlockAudio, play, testSound, setEnabled, setVolume, getState };
  }

  return { create, patterns: SOUND_PATTERNS };
});