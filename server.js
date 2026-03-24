const express = require('express');
const app = express();

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Root test
app.get('/', (req, res) => {
  res.send('Server is running');
});

// SAFE voice handler
function handleVoice(req, res) {
  try {
    const twiml = new VoiceResponse();

    twiml.say('Welcome to R L Small Engines. Please say your name.');

    res.set('Content-Type', 'text/xml');
    res.send(twiml.toString());
  } catch (err) {
    console.error('VOICE ERROR:', err);
    res.status(500).send('Error');
  }
}

// Support BOTH GET and POST
app.get('/voice', handleVoice);
app.post('/voice', handleVoice);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
