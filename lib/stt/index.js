
const path = require('node:path');
const transcribe = async(logger, socket, url, authToken) => {
  const p = path.basename(url);
  switch (p) {
    case 'google':
      return require('./google')(logger, socket);
    case 'assemblyAI':
      return require('./assemblyAi')(logger, socket);
    case 'vosk':
      return require('./vosk')(logger, socket);
    case 'gladia':
      return require('./gladia')(logger, socket);
    case 'test':
      return require('./test')(logger, socket);
    case 'deepgramFlux':
      return require('./deepgramFlux')(logger, socket, authToken);
    default:
      logger.info(`unknown stt vendor: ${p}`);
      socket.close();
  }
};

module.exports = transcribe;
