/*
 * Throwaway echo stub — NOT a real STT vendor.
 *
 * Exists only to validate the deployment platform (DigitalOcean App Platform,
 * Sydney region) actually terminates wss:// WebSocket upgrades on its public
 * domain and lets a VG "start" -> audio -> "transcription" -> "stop" exchange
 * flow through. No transcription happens here — on "start" it just logs the
 * message and immediately sends back a fixed final transcription so we can
 * confirm end-to-end connectivity from Voice Gateway before wiring the real
 * Deepgram Flux integration.
 */
const transcribe = async (logger, socket) => {
  socket.on('message', (data, isBinary) => {
    if (isBinary) {
      logger.info({bytes: data.length}, 'test stub: received audio frame');
      return;
    }
    try {
      const obj = JSON.parse(data.toString());
      logger.info({obj}, 'test stub: received JSON message from Cognigy Voice Gateway');

      if (obj.type === 'start') {
        const {language} = obj;
        socket.send(JSON.stringify({
          type: 'transcription',
          is_final: true,
          alternatives: [{confidence: 1, transcript: 'test stub connection ok'}],
          channel: 1,
          language
        }));
      } else if (obj.type === 'stop') {
        socket.close();
      }
    } catch (err) {
      logger.error({err}, 'test stub: error parsing message');
    }
  });

  socket.on('error', (err) => {
    logger.error({err}, 'test stub: socket error');
  });
  socket.on('close', () => {
    logger.info('test stub: socket closed');
  });
};

module.exports = transcribe;
