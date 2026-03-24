const express = require('express');
const fs = require('fs');

const app = express();
app.use(express.urlencoded({ extended: true }));

const serviceAreaZips = ['20724', '21054', '21113'];
const CALLS_FILE = 'calls.txt';

// =======================
// OPTIONAL TWILIO SMS ALERTS
// =======================
const accountSid = '';
const authToken = '';
const FROM_NUMBER = '';
const TO_NUMBER = '';

// =======================
// SMART MACHINE MAP
// YOU CAN EDIT THIS ANYTIME
// =======================
const machineMap = {
  'lawn mower': [
    'lawn mower',
    'lawnmower',
    'mower',
    'zero turn',
    'zeroturn',
    'push mower'
  ],
  'riding mower': [
    'riding mower',
    'rider',
    'riding lawn mower'
  ],
  'generator': [
    'generator',
    'gen'
  ],
  'pressure washer': [
    'pressure washer',
    'pressurewasher',
    'power washer',
    'powerwasher'
  ],
  'snowblower': [
    'snowblower',
    'snow blower',
    'snow thrower'
  ]
};

// =======================
// HELPERS
// =======================
function cleanText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function displayText(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return 'Unknown';
  return cleaned
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// =======================
// SMART MACHINE DETECTION
// =======================
function detectMachine(input) {
  const cleaned = cleanText(input);

  for (const main in machineMap) {
    for (const term of machineMap[main]) {
      if (cleaned.includes(term)) {
        return main;
      }
    }
  }

  return null;
}

function formatDigitsForSpeech(digits) {
  return (digits || '').split('').join(' ');
}

function xmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function saveCall(data) {
  fs.appendFileSync(CALLS_FILE, JSON.stringify(data) + '\n');
}

async function sendTextAlert(data) {
  if (!accountSid || !authToken || !FROM_NUMBER || !TO_NUMBER) return;

  try {
    const twilio = require('twilio');
    const client = twilio(accountSid, authToken);

    await client.messages.create({
      body: `New Request\nType: ${data.requestType}\nMachine: ${data.machine}\nIssue: ${data.issue}\nPhone: ${data.phone}`,
      from: FROM_NUMBER,
      to: TO_NUMBER
    });
  } catch (e) {
    console.log('SMS failed:', e.message);
  }
}

// =======================
// FLOW
// =======================
app.post('/voice', (req, res) => {
  res.type('text/xml').send(`
    <Response>
      <Gather input="speech" action="/getName">
        <Say>Hello, this is R L Small Engines. Please say your name.</Say>
      </Gather>
    </Response>
  `);
});

app.post('/getName', (req, res) => {
  const name = displayText(req.body.SpeechResult);

  res.type('text/xml').send(`
    <Response>
      <Gather input="dtmf" numDigits="1" action="/checkName?name=${encodeURIComponent(name)}">
        <Say>I heard ${xmlEscape(name)}. Press 1 to confirm or 2 to repeat.</Say>
      </Gather>
    </Response>
  `);
});

app.post('/checkName', (req, res) => {
  const name = req.query.name;

  if (req.body.Digits === '2') {
    return res.type('text/xml').send(`
      <Response>
        <Redirect>/voice</Redirect>
      </Response>
    `);
  }

  res.type('text/xml').send(`
    <Response>
      <Gather input="speech" action="/getMachine?name=${encodeURIComponent(name)}">
        <Say>What machine are you calling about?</Say>
      </Gather>
    </Response>
  `);
});

app.post('/getMachine', (req, res) => {
  const name = req.query.name;
  const raw = req.body.SpeechResult || '';

  const detected = detectMachine(raw);
  const spoken = displayText(raw);

  res.type('text/xml').send(`
    <Response>
      <Gather input="dtmf" numDigits="1" action="/checkMachine?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(detected || '')}&amp;spoken=${encodeURIComponent(spoken)}">
        <Say>I heard ${xmlEscape(spoken)}. Press 1 to confirm or 2 to repeat.</Say>
      </Gather>
    </Response>
  `);
});

app.post('/checkMachine', (req, res) => {
  const name = req.query.name;
  const machine = req.query.machine;
  const spoken = req.query.spoken;

  if (req.body.Digits === '2') {
    return res.type('text/xml').send(`
      <Response>
        <Redirect>/getMachine?name=${encodeURIComponent(name)}</Redirect>
      </Response>
    `);
  }

  if (!machine) {
    return res.type('text/xml').send(`
      <Response>
        <Say>Sorry, we do not service that equipment.</Say>
      </Response>
    `);
  }

  res.type('text/xml').send(`
    <Response>
      <Gather input="speech" action="/getIssue?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}">
        <Say>Got it. ${xmlEscape(machine)}. What problem are you having?</Say>
      </Gather>
    </Response>
  `);
});

app.post('/getIssue', (req, res) => {
  const { name, machine } = req.query;
  const issue = displayText(req.body.SpeechResult);

  res.type('text/xml').send(`
    <Response>
      <Gather input="dtmf" numDigits="1" action="/checkIssue?name=${name}&amp;machine=${machine}&amp;issue=${encodeURIComponent(issue)}">
        <Say>I heard ${xmlEscape(issue)}. Press 1 to confirm or 2 to repeat.</Say>
      </Gather>
    </Response>
  `);
});

app.post('/checkIssue', (req, res) => {
  const { name, machine, issue } = req.query;

  if (req.body.Digits === '2') {
    return res.type('text/xml').send(`
      <Response>
        <Redirect>/getIssue?name=${name}&amp;machine=${machine}</Redirect>
      </Response>
    `);
  }

  res.type('text/xml').send(`
    <Response>
      <Gather input="dtmf" numDigits="5" action="/getZip?name=${name}&amp;machine=${machine}&amp;issue=${issue}">
        <Say>Enter your zip code.</Say>
      </Gather>
    </Response>
  `);
});

app.post('/getZip', (req, res) => {
  const { name, machine, issue } = req.query;
  const zip = req.body.Digits;

  res.type('text/xml').send(`
    <Response>
      <Gather input="dtmf" numDigits="1" action="/checkZip?name=${name}&amp;machine=${machine}&amp;issue=${issue}&amp;zip=${zip}">
        <Say>You entered ${zip}. Press 1 to confirm.</Say>
      </Gather>
    </Response>
  `);
});

app.post('/checkZip', (req, res) => {
  const { name, machine, issue, zip } = req.query;

  if (!serviceAreaZips.includes(zip)) {
    return res.type('text/xml').send(`
      <Response>
        <Say>We do not service your area.</Say>
      </Response>
    `);
  }

  res.type('text/xml').send(`
    <Response>
      <Gather input="dtmf" numDigits="10" action="/getPhone?name=${name}&amp;machine=${machine}&amp;issue=${issue}&amp;zip=${zip}">
        <Say>Enter your phone number.</Say>
      </Gather>
    </Response>
  `);
});

app.post('/getPhone', (req, res) => {
  const { name, machine, issue, zip } = req.query;
  const phone = req.body.Digits;

  res.type('text/xml').send(`
    <Response>
      <Gather input="dtmf" numDigits="1" action="/final?name=${name}&amp;machine=${machine}&amp;issue=${issue}&amp;zip=${zip}&amp;phone=${phone}">
        <Say>Press 1 for message. Press 2 for appointment.</Say>
      </Gather>
    </Response>
  `);
});

app.post('/final', async (req, res) => {
  const { name, machine, issue, zip, phone } = req.query;
  const type = req.body.Digits === '2' ? 'Appointment' : 'Message';

  const data = {
    requestType: type,
    name,
    machine,
    issue,
    zip,
    phone,
    time: new Date().toISOString()
  };

  saveCall(data);
  await sendTextAlert(data);

  res.type('text/xml').send(`
    <Response>
      <Say>Thank you. We will contact you shortly.</Say>
    </Response>
  `);
});

app.listen(3000, () => console.log('Server running on port 3000'));