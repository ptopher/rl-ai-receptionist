const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));

// Test route
app.get('/', (req, res) => {
  res.send('Server running');
});

// Voice route (NO twilio library)
function voiceHandler(req, res) {
  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      <Say>Welcome to R L Small Engines. Please say your name.</Say>
    </Response>
  `);
}

// Support both GET and POST
app.get('/voice', voiceHandler);
app.post('/voice', voiceHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
