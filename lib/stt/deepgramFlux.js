/*
 * Deepgram Flux (AU region) custom STT vendor.
 *
 * Unlike the other STT vendors in this repo, this module does not use a
 * static DEEPGRAM_API_KEY env var. Instead, the Authorization: Bearer token
 * that Cognigy Voice Gateway sends when opening the WebSocket connection is
 * forwarded to Deepgram as-is (as `Authorization: Token <token>`). Whoever
 * configures the VG custom-STT credential enters their real Deepgram API key
 * as that Bearer token, so this server never owns or stores a Deepgram key.
 *
 * Flux's turn model does not map 1:1 onto VG's "is_final" contract:
 *   - StartOfTurn / TurnResumed carry no new transcript text worth forwarding.
 *   - Update and EagerEndOfTurn are both provisional — EagerEndOfTurn is only
 *     "moderate confidence" and can be followed by TurnResumed, so neither is
 *     sent as is_final: true. Only Flux's EndOfTurn event is authoritative,
 *     since VG ends the listening turn as soon as it sees is_final: true (see
 *     DEVELOPER_GUIDE.md) and a premature final would cut the caller off
 *     mid-utterance.
 */
const Websocket = require('ws');

const DEEPGRAM_FLUX_URL = process.env.DEEPGRAM_FLUX_URL || 'wss://api.au.deepgram.com/v2/listen';
const MODEL = 'flux-general-en';

const LANGUAGE_NAME_TO_CODE = {
  english: 'en',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  mandarin: 'zh',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
  hindi: 'hi',
  arabic: 'ar'
};

const toLanguageHint = (language) => {
  if (!language) return undefined;
  const key = String(language).trim().toLowerCase();
  if (LANGUAGE_NAME_TO_CODE[key]) return LANGUAGE_NAME_TO_CODE[key];
  if (/^[a-z]{2}(-[a-z]{2,4})?$/.test(key)) return key;
  return undefined;
};

const averageConfidence = (words) => {
  if (!Array.isArray(words) || words.length === 0) return undefined;
  const sum = words.reduce((acc, w) => acc + (typeof w.confidence === 'number' ? w.confidence : 0), 0);
  return sum / words.length;
};

const closeFluxSocket = (socket) => {
  if (!socket.fluxSocket) return;
  try {
    socket.fluxSocket.send(JSON.stringify({type: 'CloseStream'}));
  } catch (err) {
    /* Flux socket may already be closing; nothing to do */
  }
  socket.fluxSocket.close();
  socket.fluxSocket = null;
};

const transcribe = async (logger, socket, authToken) => {
  if (!authToken) {
    logger.error('deepgramFlux: no Authorization token received from Cognigy Voice Gateway connection');
    socket.close();
    return;
  }

  socket.on('message', (data, isBinary) => {
    try {
      if (!isBinary) {
        const obj = JSON.parse(data.toString());
        logger.info({obj}, 'deepgramFlux: received JSON message from Cognigy Voice Gateway');

        if (obj.type === 'start') {
          if (socket.fluxSocket) {
            logger.error('deepgramFlux: expected start only once per connection');
            return;
          }
          const {encoding, sampleRateHz, language, interimResults} = obj;
          socket.interimResults = Boolean(interimResults);
          socket.language = language;

          const params = new URLSearchParams({
            model: MODEL,
            encoding: (encoding || 'linear16').toLowerCase(),
            sample_rate: String(sampleRateHz)
          });
          /* language_hint is rejected outright (400 INVALID_QUERY_PARAMETER) on
           * flux-general-en - Deepgram only accepts it on flux-general-multi. */
          if (MODEL === 'flux-general-multi') {
            const languageHint = toLanguageHint(language);
            if (languageHint) params.set('language_hint', languageHint);
          }

          const fluxUrl = `${DEEPGRAM_FLUX_URL}?${params.toString()}`;
          const fluxSocket = new Websocket(fluxUrl, {
            headers: {Authorization: `Token ${authToken}`}
          });
          socket.fluxSocket = fluxSocket;

          fluxSocket.on('open', () => {
            logger.info('deepgramFlux: connected to Deepgram Flux');
          });

          fluxSocket.on('message', (buffer) => {
            let msg;
            try {
              msg = JSON.parse(buffer.toString());
            } catch (err) {
              logger.error({err}, 'deepgramFlux: failed to parse Flux message');
              return;
            }
            logger.info({msg}, 'deepgramFlux: received message from Deepgram Flux');

            if (msg.type === 'TurnInfo') {
              const {event, transcript, words} = msg;
              if (event === 'EndOfTurn') {
                socket.send(JSON.stringify({
                  type: 'transcription',
                  is_final: true,
                  alternatives: [{confidence: averageConfidence(words), transcript}],
                  channel: 1,
                  language: socket.language
                }));
              } else if ((event === 'Update' || event === 'EagerEndOfTurn') && socket.interimResults) {
                socket.send(JSON.stringify({
                  type: 'transcription',
                  is_final: false,
                  alternatives: [{confidence: averageConfidence(words), transcript}],
                  channel: 1,
                  language: socket.language
                }));
              }
              /* StartOfTurn / TurnResumed carry no transcript update worth forwarding */
            } else if (msg.type === 'Error') {
              logger.error({msg}, 'deepgramFlux: Flux fatal error');
              socket.send(JSON.stringify({type: 'error', error: msg.description || 'Deepgram Flux error'}));
            }
          });

          fluxSocket.on('error', (err) => {
            logger.error({err}, 'deepgramFlux: Flux socket error');
          });
          fluxSocket.on('close', () => {
            logger.info('deepgramFlux: Flux socket closed');
            socket.fluxSocket = null;
          });
        } else if (obj.type === 'stop') {
          closeFluxSocket(socket);
          socket.close();
        }
      } else if (socket.fluxSocket && socket.fluxSocket.readyState === Websocket.OPEN) {
        socket.fluxSocket.send(data);
      }
    } catch (err) {
      logger.error({err}, 'deepgramFlux: error handling message');
    }
  });

  socket.on('error', (err) => {
    logger.error({err}, 'deepgramFlux: Cognigy Voice Gateway socket error');
    closeFluxSocket(socket);
  });
  socket.on('close', () => {
    logger.info('deepgramFlux: Cognigy Voice Gateway socket closed');
    closeFluxSocket(socket);
  });
};

module.exports = transcribe;
