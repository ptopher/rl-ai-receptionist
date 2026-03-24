const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));

app.get('/', (req, res) => {
  res.send('Server running');
});

function voiceTwiml() {
  return `
    <Response>
      <Gather input="speech" action="/getName" method="POST" speechTimeout="auto" timeout="5">
        <Say>Welcome to R L Small Engines. Please say your name.</Say>
      </Gather>
      <Say>I did not hear anything. Goodbye.</Say>
    </Response>
  `;
}

app.get('/voice', (req, res) => {
  res.type('text/xml');
  res.send(voiceTwiml());
});

app.post('/voice', (req, res) => {
  res.type('text/xml');
  res.send(voiceTwiml());
});

app.post('/getName', (req, res) => {
  const name = req.body.SpeechResult || 'customer';

  res.type('text/xml');
  res.send(`
    <Response>
      <Say>Thank you ${name}. Your hosted call flow is working. Goodbye.</Say>
    </Response>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
