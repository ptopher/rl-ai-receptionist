const express = require('express');
const app = express();
const VoiceResponse = require('twilio').twiml.VoiceResponse;

app.use(express.urlencoded({ extended: false }));

app.get('/', (req, res) => {
  res.send('Server is running');
});

function buildVoiceResponse() {
  const twiml = new VoiceResponse();
  twiml.say('Welcome to R L Small Engines. Please say your name.');
  return twiml.toString();
}

app.get('/voice', (req, res) => {
  res.type('text/xml');
  res.send(buildVoiceResponse());
});

app.post('/voice', (req, res) => {
  res.type('text/xml');
  res.send(buildVoiceResponse());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
