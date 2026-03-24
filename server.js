const express = require('express');
const fs = require('fs');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const serviceAreaZips = ['20724', '21054', '21113'];
const CALLS_FILE = 'calls.txt';

const machineMap = {
  'Lawn Mower': [
    'lawn mower',
    'lawnmower',
    'mower',
    'push mower',
    'zero turn',
    'zeroturn'
  ],
  'Riding Mower': [
    'riding mower',
    'riding lawn mower',
    'rider'
  ],
  'Generator': [
    'generator',
    'gen'
  ],
  'Pressure Washer': [
    'pressure washer',
    'pressurewasher',
    'power washer',
    'powerwasher'
  ],
  'Snowblower': [
    'snowblower',
    'snow blower',
    'snow thrower'
  ]
};

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
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function detectMachine(input) {
  const cleaned = cleanText(input);

  for (const machineName of Object.keys(machineMap)) {
    for (const phrase of machineMap[machineName]) {
      if (cleaned.includes(phrase)) {
        return machineName;
      }
    }
  }

  return null;
}

function xmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDigitsForSpeech(digits) {
  return (digits || '').split('').join(' ');
}

function saveCall(data) {
  fs.appendFileSync(CALLS_FILE, JSON.stringify(data) + '\n');
}

function buildVoiceResponse() {
  return `
    <Response>
      <Gather input="speech" action="/getName" method="POST" speechTimeout="auto" timeout="5">
        <Say>Welcome to R L Small Engines. Please say your name.</Say>
      </Gather>
      <Say>I did not hear anything. Goodbye.</Say>
    </Response>
  `;
}

app.get('/', (req, res) => {
  res.send('RL AI Receptionist is running');
});

app.get('/voice', (req, res) => {
  res.type('text/xml');
  res.send(buildVoiceResponse());
});

app.post('/voice', (req, res) => {
  res.type('text/xml');
  res.send(buildVoiceResponse());
});

app.post('/getName', (req, res) => {
  const name = displayText(req.body.SpeechResult);

  res.type('text/xml');
  res.send(`
    <Response>
      <Gather input="dtmf" numDigits="1" timeout="10" action="/checkName?name=${encodeURIComponent(name)}" method="POST">
        <Say>I heard ${xmlEscape(name)}. If this is correct, press 1. To say your name again, press 2.</Say>
      </Gather>
      <Say>We did not receive a response. Goodbye.</Say>
    </Response>
  `);
});

app.post('/checkName', (req, res) => {
  const name = req.query.name || 'Unknown';
  const choice = req.body.Digits || '';

  res.type('text/xml');

  if (choice === '2') {
    res.send(`
      <Response>
        <Gather input="speech" action="/getName" method="POST" speechTimeout="auto" timeout="5">
          <Say>Please say your name again.</Say>
        </Gather>
        <Say>I did not hear anything. Goodbye.</Say>
      </Response>
    `);
    return;
  }

  res.send(`
    <Response>
      <Gather input="speech" action="/getMachine?name=${encodeURIComponent(name)}" method="POST" speechTimeout="auto" timeout="5">
        <Say>Thank you ${xmlEscape(name)}. What machine are you calling about? For example, lawn mower, riding mower, generator, pressure washer, or snowblower.</Say>
      </Gather>
      <Say>I did not hear anything. Goodbye.</Say>
    </Response>
  `);
});

app.post('/getMachine', (req, res) => {
  const name = req.query.name || 'Unknown';
  const spokenMachine = displayText(req.body.SpeechResult);

  res.type('text/xml');
  res.send(`
    <Response>
      <Gather input="dtmf" numDigits="1" timeout="10" action="/checkMachine?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(spokenMachine)}" method="POST">
        <Say>I heard ${xmlEscape(spokenMachine)}. If this is correct, press 1. To say the machine again, press 2.</Say>
      </Gather>
      <Say>We did not receive a response. Goodbye.</Say>
    </Response>
  `);
});

app.post('/checkMachine', (req, res) => {
  const name = req.query.name || 'Unknown';
  const spokenMachine = req.query.machine || 'Unknown';
  const choice = req.body.Digits || '';

  res.type('text/xml');

  if (choice === '2') {
    res.send(`
      <Response>
        <Gather input="speech" action="/getMachine?name=${encodeURIComponent(name)}" method="POST" speechTimeout="auto" timeout="5">
          <Say>Please say the machine again.</Say>
        </Gather>
        <Say>I did not hear anything. Goodbye.</Say>
      </Response>
    `);
    return;
  }

  const detectedMachine = detectMachine(spokenMachine);

  if (!detectedMachine) {
    res.send(`
      <Response>
        <Say>Sorry, we do not service that type of equipment.</Say>
        <Say>Please call again for supported machines. Goodbye.</Say>
      </Response>
    `);
    return;
  }

  res.send(`
    <Response>
      <Gather input="speech" action="/getIssue?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(detectedMachine)}" method="POST" speechTimeout="auto" timeout="6">
        <Say>Got it. You said ${xmlEscape(detectedMachine)}. What problem are you having?</Say>
      </Gather>
      <Say>I did not hear anything. Goodbye.</Say>
    </Response>
  `);
});

app.post('/getIssue', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = displayText(req.body.SpeechResult);

  res.type('text/xml');
  res.send(`
    <Response>
      <Gather input="dtmf" numDigits="1" timeout="10" action="/checkIssue?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}" method="POST">
        <Say>I heard ${xmlEscape(issue)}. If this is correct, press 1. To say the problem again, press 2.</Say>
      </Gather>
      <Say>We did not receive a response. Goodbye.</Say>
    </Response>
  `);
});

app.post('/checkIssue', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const choice = req.body.Digits || '';

  res.type('text/xml');

  if (choice === '2') {
    res.send(`
      <Response>
        <Gather input="speech" action="/getIssue?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}" method="POST" speechTimeout="auto" timeout="6">
          <Say>Please say the problem again.</Say>
        </Gather>
        <Say>I did not hear anything. Goodbye.</Say>
      </Response>
    `);
    return;
  }

  res.send(`
    <Response>
      <Gather input="dtmf" numDigits="5" timeout="10" action="/getZip?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}" method="POST">
        <Say>Please enter your five digit zip code using your keypad.</Say>
      </Gather>
      <Say>We did not receive your zip code. Goodbye.</Say>
    </Response>
  `);
});

app.post('/getZip', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = (req.body.Digits || '').slice(0, 5);
  const spokenZip = formatDigitsForSpeech(zip);

  res.type('text/xml');
  res.send(`
    <Response>
      <Gather input="dtmf" numDigits="1" timeout="10" action="/checkZip?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}&amp;zip=${encodeURIComponent(zip)}" method="POST">
        <Say>You entered zip code ${spokenZip}. If this is correct, press 1. To re enter your zip code, press 2.</Say>
      </Gather>
      <Say>We did not receive a response. Goodbye.</Say>
    </Response>
  `);
});

app.post('/checkZip', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || '';
  const choice = req.body.Digits || '';

  res.type('text/xml');

  if (choice === '2') {
    res.send(`
      <Response>
        <Gather input="dtmf" numDigits="5" timeout="10" action="/getZip?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}" method="POST">
          <Say>Please re enter your five digit zip code using your keypad.</Say>
        </Gather>
        <Say>We did not receive your zip code. Goodbye.</Say>
      </Response>
    `);
    return;
  }

  if (!serviceAreaZips.includes(zip)) {
    const spokenZip = formatDigitsForSpeech(zip);
    res.send(`
      <Response>
        <Say>Sorry, we do not currently service zip code ${spokenZip}.</Say>
        <Say>Please leave your name, number, and message after the tone.</Say>
        <Record maxLength="60" action="/voicemail?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}&amp;zip=${encodeURIComponent(zip)}" method="POST" />
        <Say>We did not receive a message. Goodbye.</Say>
      </Response>
    `);
    return;
  }

  res.send(`
    <Response>
      <Say>Thank you. We do service your area.</Say>
      <Gather input="dtmf" numDigits="10" timeout="10" action="/getPhone?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}&amp;zip=${encodeURIComponent(zip)}" method="POST">
        <Say>Please enter your ten digit phone number using your keypad.</Say>
      </Gather>
      <Say>We did not receive your phone number. Goodbye.</Say>
    </Response>
  `);
});

app.post('/getPhone', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const phone = (req.body.Digits || '').slice(0, 10);
  const spokenPhone = formatDigitsForSpeech(phone);

  res.type('text/xml');
  res.send(`
    <Response>
      <Gather input="dtmf" numDigits="1" timeout="10" action="/checkPhone?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}&amp;zip=${encodeURIComponent(zip)}&amp;phone=${encodeURIComponent(phone)}" method="POST">
        <Say>You entered phone number ${spokenPhone}. If this is correct, press 1. To re enter your phone number, press 2.</Say>
      </Gather>
      <Say>We did not receive a response. Goodbye.</Say>
    </Response>
  `);
});

app.post('/checkPhone', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const phone = req.query.phone || '';
  const choice = req.body.Digits || '';

  res.type('text/xml');

  if (choice === '2') {
    res.send(`
      <Response>
        <Gather input="dtmf" numDigits="10" timeout="10" action="/getPhone?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}&amp;zip=${encodeURIComponent(zip)}" method="POST">
          <Say>Please re enter your ten digit phone number using your keypad.</Say>
        </Gather>
        <Say>We did not receive your phone number. Goodbye.</Say>
      </Response>
    `);
    return;
  }

  res.send(`
    <Response>
      <Gather input="dtmf" numDigits="1" timeout="10" action="/getRequestType?name=${encodeURIComponent(name)}&amp;machine=${encodeURIComponent(machine)}&amp;issue=${encodeURIComponent(issue)}&amp;zip=${encodeURIComponent(zip)}&amp;phone=${encodeURIComponent(phone)}" method="POST">
        <Say>Press 1 to leave a message for follow up. Press 2 to request an appointment.</Say>
      </Gather>
      <Say>We did not receive a response. Goodbye.</Say>
    </Response>
  `);
});

app.post('/getRequestType', (req, res) => {
  const name = req.query.name || 'Unknown';
  const machine = req.query.machine || 'Unknown';
  const issue = req.query.issue || 'Unknown';
  const zip = req.query.zip || 'Unknown';
  const phone = req.query.phone || '';
  const choice = req.body.Digits || '';

  const requestType = choice === '2' ? 'Appointment Request' : 'Message';

  const data = {
    requestType,
    name,
    machine,
    issue,
    zip,
    phone,
    time: new Date().toISOString()
  };

  saveCall(data);

  res.type('text/xml');
  res.send(`
    <Response>
      <Say>Thank you. Your ${requestType.toLowerCase()} has been received. We will contact you shortly. Goodbye.</Say>
    </Response>
  `);
});

app.post('/voicemail', (req, res) => {
  const data = {
    requestType: 'Out Of Area Voicemail',
    name: req.query.name || 'Unknown',
    machine: req.query.machine || 'Unknown',
    issue: req.query.issue || 'Unknown',
    zip: req.query.zip || 'Unknown',
    recording: req.body.RecordingUrl || '',
    time: new Date().toISOString()
  };

  saveCall(data);

  res.type('text/xml');
  res.send(`
    <Response>
      <Say>Thank you. Your message has been recorded. Goodbye.</Say>
    </Response>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
