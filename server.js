const express = require('express');
const app = express();
const VoiceResponse = require('twilio').twiml.VoiceResponse;

app.use(express.urlencoded({ extended: false }));

// ROOT (for browser test)
app.get('/', (req, res) => {
  res.send('Server is running');
});

// TWILIO VOICE ROUTE
app.post('/voice', (req, res) => {
  const twiml = new VoiceResponse();

  twiml.say('Welcome to RL Small Engines. Please say your name.');

  res.type('text/xml');
  res.send(twiml.toString());
});

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
